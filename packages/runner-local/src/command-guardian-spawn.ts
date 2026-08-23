import { admitBoundPtySpawnResult } from "./command-guardian-capability.js";
import { GuardianPreSpawnCapture } from "./command-guardian-pre-spawn.js";
import { GuardianDurableRecorder } from "./command-guardian-recorder.js";
import {
  createLiveRunningEvidence,
  createRejectedSpawnEvidence,
  createSpawnAuthorizationEvidence,
  createTransferredLeaseEvidence
} from "./command-phase-evidence.js";
import type { CommandGuardianLaunchOptions } from "./command-guardian-types.js";
import type { BoundPtySpawnResult } from "./pty.js";

export interface AuthorizedGuardianSpawn {
  readonly result: BoundPtySpawnResult;
  readonly capture: GuardianPreSpawnCapture;
}

export const authorizeAndSpawnGuardian = async (
  options: CommandGuardianLaunchOptions,
  recorder: GuardianDurableRecorder,
  markAttemptStarted: () => void
): Promise<AuthorizedGuardianSpawn> => {
  const transferred = await options.spool.recordPhase("lease_transferred", {
    recordedAt: recorder.receiptTime(),
    evidence: createTransferredLeaseEvidence(
      options.spool.intent,
      options.guardianNonceDigest ?? null
    )
  });
  await recorder.notifyPhase("lease_transferred", transferred.receiptDigest);
  const authorization = await options.spool.recordPhase("spawned", {
    recordedAt: recorder.receiptTime(),
    evidence: createSpawnAuthorizationEvidence(options.spool.intent)
  });
  await recorder.notifyPhase("spawned", authorization.receiptDigest);
  const capture = new GuardianPreSpawnCapture(options.sensitiveValues);
  markAttemptStarted();
  const result = admitBoundPtySpawnResult(
    options.spawnAuthority.spawnBound({
      request: options.envelope,
      expectedExecutableIdentityDigest: options.spool.intent.executableIdentityDigest,
      expectedCwdIdentityDigest: options.spool.intent.cwdIdentityDigest,
      privateEnvironment: {
        home: options.envelope.environment.find((entry) => entry.name === "HOME")?.value ?? "",
        temporary:
          options.envelope.environment.find((entry) => entry.name === "TMPDIR")?.value ?? ""
      },
      capture: capture.capture
    })
  );
  return Object.freeze({ result, capture });
};

export const recordGuardianRunning = async (
  options: CommandGuardianLaunchOptions,
  recorder: GuardianDurableRecorder,
  observedExit: boolean
): Promise<void> => {
  const started = await recorder.appendEvent({ type: "command.started", pty: true }, 0, false);
  await recorder.notifyFrame(started);
  const running = await options.spool.recordPhase("running", {
    recordedAt: recorder.receiptTime(),
    evidence: createLiveRunningEvidence(started.frameDigest, observedExit)
  });
  await recorder.notifyPhase("running", running.receiptDigest);
};

export const recordRejectedSpawn = async (
  options: CommandGuardianLaunchOptions,
  recorder: GuardianDurableRecorder,
  capture: GuardianPreSpawnCapture
): Promise<void> => {
  const snapshot = capture.drain();
  if (
    snapshot.chunks.length !== 0 ||
    snapshot.eofObserved ||
    snapshot.exit !== undefined ||
    snapshot.failure !== undefined
  ) {
    throw new TypeError("Rejected guardian spawn emitted process evidence.");
  }
  const started = await recorder.appendEvent({ type: "command.started", pty: true }, 0, false);
  await recorder.notifyFrame(started);
  const running = await options.spool.recordPhase("running", {
    recordedAt: recorder.receiptTime(),
    evidence: createRejectedSpawnEvidence(started.frameDigest)
  });
  await recorder.notifyPhase("running", running.receiptDigest);
};
