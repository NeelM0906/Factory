import { snapshotDataRecord } from "./command-guardian-bounds.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const exactKeys = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

export interface GuardianPhaseEvidenceIdentity {
  readonly guardianSessionBindingDigest: string;
  readonly executableIdentityDigest: string;
  readonly cwdIdentityDigest: string;
}

export const createTransferredLeaseEvidence = (
  identity: GuardianPhaseEvidenceIdentity,
  guardianNonceDigest: string | null
) =>
  Object.freeze({
    guardianSessionBindingDigest: identity.guardianSessionBindingDigest,
    guardianNonceDigest,
    leaseTransferred: true as const
  });

export const createSpawnAuthorizationEvidence = (identity: GuardianPhaseEvidenceIdentity) =>
  Object.freeze({
    spawnAuthorized: true as const,
    executableIdentityDigest: identity.executableIdentityDigest,
    cwdIdentityDigest: identity.cwdIdentityDigest
  });

export const createLiveRunningEvidence = (startedFrameDigest: string, observedExit: boolean) =>
  observedExit
    ? Object.freeze({
        startedFrameDigest,
        liveCapability: false as const,
        exitedBeforeRunning: true as const
      })
    : Object.freeze({ startedFrameDigest, liveCapability: true as const });

export const createRejectedSpawnEvidence = (startedFrameDigest: string) =>
  Object.freeze({
    startedFrameDigest,
    liveCapability: false as const,
    spawnRejected: true as const
  });

export const createRecoveredLeaseEvidence = () =>
  Object.freeze({ recovered: true as const, leaseTransferred: false as const });

export const createRecoveredUnspawnedEvidence = () =>
  Object.freeze({ recovered: true as const, spawnAuthorized: false as const });

export const createRecoveredSpawnFailureEvidence = () =>
  Object.freeze({
    recovered: true as const,
    liveCapability: false as const,
    spawnFailed: true as const
  });

export const admitGuardianPhaseEvidence = (input: {
  readonly phase: "lease_transferred" | "spawned" | "running";
  readonly evidence: unknown;
  readonly identity: GuardianPhaseEvidenceIdentity;
  readonly startedFrameDigest?: string;
}): Readonly<Record<string, unknown>> => {
  const evidence = snapshotDataRecord(input.evidence, 4);
  if (input.phase === "lease_transferred") {
    if (
      exactKeys(evidence, ["recovered", "leaseTransferred"]) &&
      evidence.recovered === true &&
      evidence.leaseTransferred === false
    )
      return Object.freeze({ ...evidence });
    if (
      exactKeys(evidence, [
        "guardianSessionBindingDigest",
        "guardianNonceDigest",
        "leaseTransferred"
      ]) &&
      evidence.guardianSessionBindingDigest === input.identity.guardianSessionBindingDigest &&
      evidence.leaseTransferred === true &&
      (evidence.guardianNonceDigest === null ||
        (typeof evidence.guardianNonceDigest === "string" &&
          SHA256_PATTERN.test(evidence.guardianNonceDigest)))
    )
      return Object.freeze({ ...evidence });
    throw new TypeError();
  }
  if (input.phase === "spawned") {
    if (
      exactKeys(evidence, ["recovered", "spawnAuthorized"]) &&
      evidence.recovered === true &&
      evidence.spawnAuthorized === false
    )
      return Object.freeze({ ...evidence });
    if (
      exactKeys(evidence, ["spawnAuthorized", "executableIdentityDigest", "cwdIdentityDigest"]) &&
      evidence.spawnAuthorized === true &&
      evidence.executableIdentityDigest === input.identity.executableIdentityDigest &&
      evidence.cwdIdentityDigest === input.identity.cwdIdentityDigest
    )
      return Object.freeze({ ...evidence });
    throw new TypeError();
  }
  if (
    exactKeys(evidence, ["recovered", "liveCapability", "spawnFailed"]) &&
    evidence.recovered === true &&
    evidence.liveCapability === false &&
    evidence.spawnFailed === true
  )
    return Object.freeze({ ...evidence });
  for (const variant of ["spawnRejected", "exitedBeforeRunning"] as const) {
    if (
      exactKeys(evidence, ["startedFrameDigest", "liveCapability", variant]) &&
      evidence.startedFrameDigest === input.startedFrameDigest &&
      evidence.liveCapability === false &&
      evidence[variant] === true
    )
      return Object.freeze({ ...evidence });
  }
  if (
    exactKeys(evidence, ["startedFrameDigest", "liveCapability"]) &&
    evidence.startedFrameDigest === input.startedFrameDigest &&
    evidence.liveCapability === true
  )
    return Object.freeze({ ...evidence });
  throw new TypeError();
};
