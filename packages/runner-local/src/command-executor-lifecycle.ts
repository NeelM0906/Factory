import type { CommandId } from "@autostack/contracts";

import type { ActiveCommandLease } from "./command-activity.js";
import { CommandDependencyTracker } from "./command-dependency-tracker.js";
import {
  admitGuardianCloseOutcome,
  captureUnadmittedGuardianHostSession,
  snapshotGuardianHostSession
} from "./command-executor-admission.js";
import { createCommandExecutorError } from "./command-executor-error.js";
import type { GuardianCloseOutcome, GuardianHostSession } from "./command-guardian.js";
import type { CommandRegistry } from "./command-registry.js";

export const guardianLifecycleTimeout = (timeoutMs: number, cancellationGraceMs: number): number =>
  Math.min(timeoutMs + cancellationGraceMs + 5_000, 90_000);

export const settleGuardianLifecycle = async (input: {
  readonly commandId: CommandId;
  readonly session: GuardianHostSession;
  readonly lease: ActiveCommandLease;
  readonly dependencies: CommandDependencyTracker;
  readonly timeoutMs: number;
  readonly markSessionClosed: (commandId: CommandId) => Promise<void>;
  readonly onClosed: () => void;
  readonly cleanupOnly?: boolean;
}): Promise<GuardianCloseOutcome> => {
  let settlement: Promise<GuardianCloseOutcome> | undefined;
  const settle = (value: unknown): Promise<GuardianCloseOutcome> => {
    settlement ??= (async () => {
      const outcome = admitGuardianCloseOutcome(value, input.commandId);
      if (!outcome.releasedLease || outcome.terminalFrame === undefined) {
        throw createCommandExecutorError("maintenance_required");
      }
      await input.markSessionClosed(input.commandId);
      await input.lease.close();
      input.onClosed();
      return outcome;
    })();
    return settlement;
  };
  const outcome = input.cleanupOnly
    ? await input.dependencies.waitForCleanup(input.session.closed)
    : await input.dependencies.wait(
        input.session.closed,
        async (lateOutcome) => {
          await settle(lateOutcome);
        },
        input.timeoutMs
      );
  return await settle(outcome);
};

export const settleRegisteredGuardianLifecycle = async (input: {
  readonly commandId: CommandId;
  readonly session: GuardianHostSession;
  readonly lease: ActiveCommandLease;
  readonly dependencies: CommandDependencyTracker;
  readonly timeoutMs: number;
  readonly registry: Pick<CommandRegistry, "markSessionClosed">;
  readonly onClosed: () => void;
}): Promise<GuardianCloseOutcome> =>
  await settleGuardianLifecycle({
    ...input,
    markSessionClosed: async (commandId) => await input.registry.markSessionClosed(commandId)
  });

export const settleLateGuardianLaunch = async (input: {
  readonly commandId: CommandId;
  readonly lateSession: unknown;
  readonly lease: ActiveCommandLease;
  readonly dependencies: CommandDependencyTracker;
  readonly timeoutMs: number;
  readonly registry: Pick<CommandRegistry, "attachSession" | "markSessionClosed">;
  readonly retainedLeases: Set<ActiveCommandLease>;
  readonly retainedSessions: Set<GuardianHostSession>;
}): Promise<void> => {
  const rawSession = captureUnadmittedGuardianHostSession(input.lateSession);
  let session: GuardianHostSession;
  try {
    session = snapshotGuardianHostSession(input.lateSession, input.commandId);
  } catch (error) {
    input.retainedLeases.add(input.lease);
    input.retainedSessions.add(rawSession);
    void rawSession.disconnect().catch(() => undefined);
    throw error;
  }
  await input.registry.attachSession(input.commandId, session);
  input.retainedLeases.add(input.lease);
  input.retainedSessions.add(session);
  const lifecycle = settleGuardianLifecycle({
    commandId: input.commandId,
    session,
    lease: input.lease,
    dependencies: input.dependencies,
    timeoutMs: input.timeoutMs,
    markSessionClosed: async (commandId) => await input.registry.markSessionClosed(commandId),
    onClosed: () => {
      input.retainedLeases.delete(input.lease);
      input.retainedSessions.delete(session);
    },
    cleanupOnly: true
  });
  void lifecycle.catch(() => undefined);
  void session.disconnect().catch(() => undefined);
  await lifecycle;
};
