import type { CommandId, StartCommandRequest } from "@autostack/contracts";

import type { CommandExecutor } from "./command-executor.js";

export interface CommandExecutorTestControl {
  retainedRequest(commandId: CommandId): StartCommandRequest | undefined;
  activeGuardianCount(): number;
  supervisionCounts(): Readonly<{
    dependencies: number;
    activityLeases: number;
    guardianSessions: number;
    registrySessions: number;
  }>;
}

const controls = new WeakMap<CommandExecutor, CommandExecutorTestControl>();

export const registerCommandExecutorTestControl = (
  executor: CommandExecutor,
  control: CommandExecutorTestControl
): void => {
  controls.set(executor, Object.freeze(control));
};

export const registerExecutorSupervisionControl = (
  executor: CommandExecutor,
  input: Readonly<{
    registry: Readonly<{
      receipt(commandId: CommandId): Readonly<{ request: unknown }> | undefined;
      activeSessions(): readonly unknown[];
    }>;
    dependencies: Readonly<{ unsettledCount: number }>;
    orphanedActivityLeases: ReadonlySet<unknown>;
    orphanedGuardianSessions: ReadonlySet<unknown>;
  }>
): void =>
  registerCommandExecutorTestControl(executor, {
    retainedRequest: (commandId) =>
      input.registry.receipt(commandId)?.request as StartCommandRequest | undefined,
    activeGuardianCount: () => input.registry.activeSessions().length,
    supervisionCounts: () =>
      Object.freeze({
        dependencies: input.dependencies.unsettledCount,
        activityLeases: input.orphanedActivityLeases.size,
        guardianSessions: input.orphanedGuardianSessions.size,
        registrySessions: input.registry.activeSessions().length
      })
  });

/** Package-private conformance seam; intentionally absent from the package entry export. */
export const commandExecutorTestControl = (
  executor: CommandExecutor
): CommandExecutorTestControl => {
  const control = controls.get(executor);
  if (control === undefined) throw new TypeError("Command executor control is unavailable.");
  return control;
};
