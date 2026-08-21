import {
  EnvironmentAuthorizationIdSchema,
  EnvironmentIdSchema,
  TerminalRunEvidenceSchema,
  type EnvironmentAuthorizationId,
  type EnvironmentId,
  type TerminalRunEvidence
} from "@autostack/contracts";

import { OwnedEnvironmentRegistryError } from "./environment-registry-errors.js";
import {
  ATTEMPT_PATTERN,
  COMMIT_PATTERN,
  SHA256_PATTERN,
  hasExactKeys,
  isCanonicalTimestamp,
  isRecord,
  type EnvironmentDisposalIntentRequest,
  type EnvironmentDisposalVerificationRequest,
  type EnvironmentIntent,
  type EnvironmentPhaseEvidence,
  type EnvironmentPhaseRequest
} from "./environment-registry-records.js";

export type RecordedPhase = "worktree_added" | "ready" | "disposal_recorded" | "disposed";
export type RecordedSequence = 2 | 3 | 4 | 5;

export interface DisposalBinding {
  readonly disposalRequestDigest: string;
  readonly environmentAuthorizationId: EnvironmentAuthorizationId;
  readonly environmentAuthorizationDigest: string;
  readonly terminalRunEvidence: TerminalRunEvidence;
}

export interface DisposalVerificationBinding {
  readonly worktreeListDigest: string;
  readonly retainedBranchCommit: string;
  readonly verifiedAt: string;
}

export interface AdmittedPhaseRequest {
  readonly environmentId: EnvironmentId;
  readonly creationAttemptId: string;
  readonly disposal?: DisposalBinding;
  readonly verification?: DisposalVerificationBinding;
}

export const admitPhaseRequest = (
  request:
    | EnvironmentPhaseRequest
    | EnvironmentDisposalIntentRequest
    | EnvironmentDisposalVerificationRequest,
  sequence: RecordedSequence
): AdmittedPhaseRequest => {
  let environmentId: unknown;
  let creationAttemptId: unknown;
  let disposalRequestDigest: unknown;
  let environmentAuthorizationId: unknown;
  let environmentAuthorizationDigest: unknown;
  let terminalRunEvidence: unknown;
  let worktreeListDigest: unknown;
  let retainedBranchCommit: unknown;
  let verifiedAt: unknown;
  try {
    const disposalPhase = sequence >= 4;
    const disposedPhase = sequence === 5;
    if (
      !isRecord(request) ||
      !hasExactKeys(request, [
        "environmentId",
        "creationAttemptId",
        ...(disposalPhase
          ? ([
              "disposalRequestDigest",
              "environmentAuthorizationId",
              "environmentAuthorizationDigest",
              "terminalRunEvidence"
            ] as const)
          : []),
        ...(disposedPhase
          ? (["worktreeListDigest", "retainedBranchCommit", "verifiedAt"] as const)
          : [])
      ])
    ) {
      throw new TypeError();
    }
    environmentId = request.environmentId;
    creationAttemptId = request.creationAttemptId;
    if (disposalPhase) {
      disposalRequestDigest = request.disposalRequestDigest;
      environmentAuthorizationId = request.environmentAuthorizationId;
      environmentAuthorizationDigest = request.environmentAuthorizationDigest;
      terminalRunEvidence = request.terminalRunEvidence;
    }
    if (disposedPhase) {
      worktreeListDigest = request.worktreeListDigest;
      retainedBranchCommit = request.retainedBranchCommit;
      verifiedAt = request.verifiedAt;
    }
  } catch {
    throw new OwnedEnvironmentRegistryError("invalid_input");
  }
  let parsedEnvironmentId: ReturnType<typeof EnvironmentIdSchema.safeParse>;
  let parsedEnvironmentAuthorizationId:
    ReturnType<typeof EnvironmentAuthorizationIdSchema.safeParse> | undefined;
  let parsedTerminalRunEvidence: ReturnType<typeof TerminalRunEvidenceSchema.safeParse> | undefined;
  try {
    parsedEnvironmentId = EnvironmentIdSchema.safeParse(environmentId);
    parsedEnvironmentAuthorizationId =
      sequence >= 4
        ? EnvironmentAuthorizationIdSchema.safeParse(environmentAuthorizationId)
        : undefined;
    parsedTerminalRunEvidence =
      sequence >= 4 ? TerminalRunEvidenceSchema.safeParse(terminalRunEvidence) : undefined;
  } catch {
    throw new OwnedEnvironmentRegistryError("invalid_input");
  }
  if (
    !parsedEnvironmentId.success ||
    typeof creationAttemptId !== "string" ||
    !ATTEMPT_PATTERN.test(creationAttemptId) ||
    (sequence >= 4 &&
      (typeof disposalRequestDigest !== "string" ||
        !SHA256_PATTERN.test(disposalRequestDigest) ||
        parsedEnvironmentAuthorizationId?.success !== true ||
        typeof environmentAuthorizationDigest !== "string" ||
        !SHA256_PATTERN.test(environmentAuthorizationDigest) ||
        parsedTerminalRunEvidence?.success !== true)) ||
    (sequence === 5 &&
      (typeof worktreeListDigest !== "string" ||
        !SHA256_PATTERN.test(worktreeListDigest) ||
        typeof retainedBranchCommit !== "string" ||
        !COMMIT_PATTERN.test(retainedBranchCommit) ||
        !isCanonicalTimestamp(verifiedAt)))
  ) {
    throw new OwnedEnvironmentRegistryError("invalid_input");
  }
  return Object.freeze({
    environmentId: parsedEnvironmentId.data,
    creationAttemptId,
    ...(sequence >= 4
      ? {
          disposal: Object.freeze({
            disposalRequestDigest: disposalRequestDigest as string,
            environmentAuthorizationId:
              parsedEnvironmentAuthorizationId?.data as EnvironmentAuthorizationId,
            environmentAuthorizationDigest: environmentAuthorizationDigest as string,
            terminalRunEvidence: Object.freeze({
              ...(parsedTerminalRunEvidence?.data as TerminalRunEvidence)
            })
          })
        }
      : {}),
    ...(sequence === 5
      ? {
          verification: Object.freeze({
            worktreeListDigest: worktreeListDigest as string,
            retainedBranchCommit: retainedBranchCommit as string,
            verifiedAt: verifiedAt as string
          })
        }
      : {})
  });
};

export const disposalBindingsEqual = (
  left: DisposalBinding | EnvironmentPhaseEvidence | undefined,
  right: DisposalBinding | EnvironmentPhaseEvidence | undefined
): boolean =>
  left?.disposalRequestDigest === right?.disposalRequestDigest &&
  left?.environmentAuthorizationId === right?.environmentAuthorizationId &&
  left?.environmentAuthorizationDigest === right?.environmentAuthorizationDigest &&
  JSON.stringify(left?.terminalRunEvidence) === JSON.stringify(right?.terminalRunEvidence);

export const phasePublicationContextMatches = (
  candidate: EnvironmentPhaseEvidence,
  intent: EnvironmentIntent,
  phase: {
    readonly phase: EnvironmentPhaseEvidence["phase"];
    readonly sequence: 1 | 2 | 3 | 4 | 5;
  },
  previous: EnvironmentPhaseEvidence | undefined,
  durableDisposal: EnvironmentPhaseEvidence | undefined
): boolean =>
  candidate.environmentId === intent.environmentId &&
  candidate.phase === phase.phase &&
  candidate.sequence === phase.sequence &&
  candidate.creationAttemptId === intent.creationAttemptId &&
  candidate.intentDigest === intent.intentDigest &&
  candidate.previousEvidenceDigest === (previous?.evidenceDigest ?? null) &&
  (previous === undefined || Date.parse(candidate.recordedAt) > Date.parse(previous.recordedAt)) &&
  (phase.sequence < 4 ||
    (candidate.environmentAuthorizationId === intent.authorization.id &&
      candidate.environmentAuthorizationDigest === intent.authorization.digest)) &&
  (phase.sequence !== 5 ||
    (durableDisposal !== undefined &&
      disposalBindingsEqual(candidate, durableDisposal) &&
      candidate.verifiedAt !== undefined &&
      Date.parse(candidate.verifiedAt) >= Date.parse(durableDisposal.recordedAt) &&
      Date.parse(candidate.verifiedAt) <= Date.parse(candidate.recordedAt)));

export const assertRecoveredPhase = (
  current: EnvironmentPhaseEvidence,
  intent: EnvironmentIntent,
  phase: {
    readonly phase: EnvironmentPhaseEvidence["phase"];
    readonly sequence: 1 | 2 | 3 | 4 | 5;
  },
  previous: EnvironmentPhaseEvidence | undefined,
  durableDisposal: EnvironmentPhaseEvidence | undefined
): void => {
  if (!phasePublicationContextMatches(current, intent, phase, previous, durableDisposal)) {
    throw new OwnedEnvironmentRegistryError("maintenance_required");
  }
};
