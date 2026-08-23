import type { BoundProcessTreeAuthority, ProcessTreeExitProof } from "./pty.js";
import { GUARDIAN_OBSERVER_TIMEOUT_MS, settleBounded } from "./command-guardian-bounds.js";
import {
  dispatchProcessSignal,
  GuardianCancellationGrace,
  proveProcessTreeExit,
  terminateProcessTree
} from "./command-guardian-process.js";
import type { GuardianDurableRecorder } from "./command-guardian-recorder.js";
import {
  GuardianSupervisionError,
  type GuardianHostControl,
  type GuardianHostObserver,
  type GuardianTerminalEvidence
} from "./command-guardian-types.js";
import type { ReplaySpool } from "./replay-spool.js";

type CancelControl = Extract<GuardianHostControl, { readonly type: "host.cancel" }> | "timeout";

export const performGuardianCancellation = async (input: {
  readonly control: CancelControl;
  readonly authority: BoundProcessTreeAuthority;
  readonly spool: ReplaySpool;
  readonly recorder: GuardianDurableRecorder;
  readonly observer: GuardianHostObserver;
  readonly cancellationGrace: GuardianCancellationGrace;
  readonly cancellationGraceMs: number;
  readonly sensitiveValues: readonly string[];
  readonly winningCause: () => GuardianTerminalEvidence["cause"] | undefined;
  readonly retainUnsafe: (retryAfter?: Promise<void>) => void;
  readonly cleanupAfterProvenFailure: () => void;
  readonly admitAuthoritativeProof: (
    proof: ProcessTreeExitProof | undefined
  ) => GuardianTerminalEvidence["exit"] | undefined;
  readonly beginTerminal: (evidence: GuardianTerminalEvidence) => Promise<void>;
  readonly ptyEofObserved: () => boolean;
}): Promise<void> => {
  const reason = input.control === "timeout" ? "timeout" : "user";
  let terminated = false;
  let actualProof: ProcessTreeExitProof | undefined;
  try {
    const claim =
      input.control === "timeout"
        ? undefined
        : await input.spool.recordCancel({
            requestDigest: input.control.requestDigest,
            decidedAt: input.control.decidedAt,
            cancelled: true
          });
    const dispatched = await dispatchProcessSignal(input.authority, "SIGINT");
    if (dispatched.retryAfter !== undefined) return input.retainUnsafe(dispatched.retryAfter);
    if (!dispatched.completed) throw new TypeError();
    if (claim !== undefined) {
      const ack = await input.spool.recordCancelAck({
        claimDigest: claim.claimDigest,
        acknowledgedAt: input.recorder.receiptTime()
      });
      try {
        await settleBounded(
          input.observer.onCancelAck?.(claim.requestDigest, claim.claimDigest, ack.ackDigest),
          GUARDIAN_OBSERVER_TIMEOUT_MS
        );
      } catch {
        // The durable acknowledgement is authoritative.
      }
    }
    await input.cancellationGrace.wait(input.cancellationGraceMs);
    if (input.winningCause() !== (reason === "user" ? "cancelled" : "timeout")) return;
    const graceful = await proveProcessTreeExit(input.authority, input.sensitiveValues);
    if (graceful.retryAfter !== undefined) return input.retainUnsafe(graceful.retryAfter);
    if (!graceful.completed) throw new TypeError();
    terminated = graceful.value?.processTreeTerminated === true;
    if (graceful.value?.processTreeTerminated === true) actualProof = graceful.value;
    if (!terminated) {
      const forcedSignal = await dispatchProcessSignal(input.authority, "SIGKILL");
      if (forcedSignal.retryAfter !== undefined) return input.retainUnsafe(forcedSignal.retryAfter);
      if (!forcedSignal.completed) throw new TypeError();
      const forced = await proveProcessTreeExit(input.authority, input.sensitiveValues);
      if (forced.retryAfter !== undefined) return input.retainUnsafe(forced.retryAfter);
      if (!forced.completed) throw new TypeError();
      terminated = forced.value?.processTreeTerminated === true;
      if (forced.value?.processTreeTerminated === true) actualProof = forced.value;
    }
  } catch {
    const cleanup = await terminateProcessTree(input.authority, "SIGTERM", input.sensitiveValues);
    if (!cleanup.terminated) input.retainUnsafe(cleanup.retryAfter);
    else input.cleanupAfterProvenFailure();
    throw new GuardianSupervisionError(
      cleanup.terminated ? "maintenance_required" : "unsafe_state"
    );
  }
  if (!terminated) return input.retainUnsafe();
  const exit = input.admitAuthoritativeProof(actualProof);
  if (exit === undefined) return input.retainUnsafe();
  await input.beginTerminal({
    cause: reason === "user" ? "cancelled" : "timeout",
    exit,
    processTreeTerminated: true,
    ptyEofObserved: input.ptyEofObserved()
  });
};
