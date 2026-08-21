import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import {
  EnvironmentAuthorizationIdSchema,
  EnvironmentAuthorizationSchema,
  EnvironmentIdSchema,
  RunIdSchema,
  SafeMetadataStringSchema,
  TerminalRunEvidenceSchema,
  WorkspaceIdSchema,
  canonicalizeEnvironmentAuthorizationForDigest,
  containsSensitiveMaterial,
  type EnvironmentAuthorization,
  type EnvironmentAuthorizationId,
  type EnvironmentId,
  type RunId,
  type TerminalRunEvidence,
  type WorkspaceId
} from "@autostack/contracts";

import {
  OwnedEnvironmentRegistryError,
  type EnvironmentRegistryErrorCode
} from "./environment-registry-errors.js";

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
export const ATTEMPT_PATTERN = /^[0-9a-f]{32}$/;
const LOCAL_REPOSITORY_IDENTITY_PATTERN = /^local-sha256:([0-9a-f]{64})$/;
const BRANCH_PATTERN = /^autostack\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
export const MAXIMUM_INTENT_BYTES = 16 * 1_024;
export const MAXIMUM_EVIDENCE_BYTES = 4 * 1_024;
export const MAXIMUM_ENVIRONMENTS = 1_000;
export const MAXIMUM_ENVIRONMENT_ROOT_ENTRIES = MAXIMUM_ENVIRONMENTS * 3 + 1;

export interface EnvironmentIntentInput {
  readonly workspaceId: WorkspaceId;
  readonly runId: RunId;
  readonly environmentId: EnvironmentId;
  readonly repositoryIdentity: string;
  readonly canonicalSourcePath: string;
  readonly repositoryCommonDirectory: string;
  readonly sourceCommit: string;
  readonly branch: string;
  readonly safeConfigDigest: string;
  readonly authorization: EnvironmentAuthorization;
  readonly prepareRequestDigest: string;
}

export interface EnvironmentIntent extends EnvironmentIntentInput {
  readonly version: 1;
  readonly kind: "environment_intent";
  readonly repositoryDigest: string;
  readonly authorizationDigest: string;
  readonly managedPath: string;
  readonly creationAttemptId: string;
  readonly intentDigest: string;
}

export type EnvironmentPhase =
  "intent_recorded" | "worktree_added" | "ready" | "disposal_recorded" | "disposed";

export interface EnvironmentPhaseEvidence {
  readonly version: 1;
  readonly kind: "environment_phase";
  readonly phase: EnvironmentPhase;
  readonly sequence: 1 | 2 | 3 | 4 | 5;
  readonly environmentId: EnvironmentId;
  readonly creationAttemptId: string;
  readonly intentDigest: string;
  readonly previousEvidenceDigest: string | null;
  readonly recordedAt: string;
  readonly disposalRequestDigest?: string;
  readonly environmentAuthorizationId?: EnvironmentAuthorizationId;
  readonly environmentAuthorizationDigest?: string;
  readonly terminalRunEvidence?: TerminalRunEvidence;
  readonly worktreeListDigest?: string;
  readonly retainedBranchCommit?: string;
  readonly verifiedAt?: string;
  readonly evidenceDigest: string;
}

export interface EnvironmentRegistryState {
  readonly intent: EnvironmentIntent;
  readonly phase: EnvironmentPhase;
  readonly evidence: readonly EnvironmentPhaseEvidence[];
}

export interface EnvironmentPhaseRequest {
  readonly environmentId: EnvironmentId;
  readonly creationAttemptId: string;
}

export interface EnvironmentDisposalIntentRequest extends EnvironmentPhaseRequest {
  readonly disposalRequestDigest: string;
  readonly environmentAuthorizationId: EnvironmentAuthorizationId;
  readonly environmentAuthorizationDigest: string;
  readonly terminalRunEvidence: TerminalRunEvidence;
}

export interface EnvironmentDisposalVerificationRequest extends EnvironmentDisposalIntentRequest {
  readonly worktreeListDigest: string;
  readonly retainedBranchCommit: string;
  readonly verifiedAt: string;
}

export interface IntentWithoutDigest extends EnvironmentIntentInput {
  readonly version: 1;
  readonly kind: "environment_intent";
  readonly repositoryDigest: string;
  readonly authorizationDigest: string;
  readonly managedPath: string;
  readonly creationAttemptId: string;
}

export interface EvidenceWithoutDigest {
  readonly version: 1;
  readonly kind: "environment_phase";
  readonly phase: EnvironmentPhase;
  readonly sequence: 1 | 2 | 3 | 4 | 5;
  readonly environmentId: EnvironmentId;
  readonly creationAttemptId: string;
  readonly intentDigest: string;
  readonly previousEvidenceDigest: string | null;
  readonly recordedAt: string;
  readonly disposalRequestDigest?: string;
  readonly environmentAuthorizationId?: EnvironmentAuthorizationId;
  readonly environmentAuthorizationDigest?: string;
  readonly terminalRunEvidence?: TerminalRunEvidence;
  readonly worktreeListDigest?: string;
  readonly retainedBranchCommit?: string;
  readonly verifiedAt?: string;
}

export const environmentIdComponent = (environmentId: EnvironmentId): string =>
  Buffer.from(environmentId, "utf8").toString("hex");

export const decodeEnvironmentIdComponent = (component: string): EnvironmentId => {
  if (
    component.length < 2 ||
    component.length > 256 ||
    component.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(component)
  ) {
    throw new OwnedEnvironmentRegistryError("maintenance_required");
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(component, "hex"));
  } catch {
    throw new OwnedEnvironmentRegistryError("maintenance_required");
  }
  const parsed = EnvironmentIdSchema.safeParse(decoded);
  if (!parsed.success || environmentIdComponent(parsed.data) !== component) {
    throw new OwnedEnvironmentRegistryError("maintenance_required");
  }
  return parsed.data;
};

export const digestRecord = (domain: string, value: object): string =>
  createHash("sha256")
    .update(`${domain}\n${JSON.stringify(value)}`, "utf8")
    .digest("hex");

export const encodeRecord = (value: object): Buffer =>
  Buffer.from(`${JSON.stringify(value)}\n`, "utf8");

export const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isCanonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value
    );
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[8] ?? "0");
  const offsetMinute = Number(match[9] ?? "0");
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maximumDay = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return (
    maximumDay !== undefined &&
    day >= 1 &&
    day <= maximumDay &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
};

const validBranch = (branch: string): boolean => {
  const segments = branch.split("/");
  return (
    branch.length <= 250 &&
    BRANCH_PATTERN.test(branch) &&
    !branch.includes("..") &&
    !branch.endsWith(".") &&
    !branch.endsWith("/") &&
    !branch.includes("//") &&
    !branch.includes("@{") &&
    !branch.endsWith(".lock") &&
    !containsSensitiveMaterial(branch) &&
    !segments.some((segment) => segment === "." || segment === ".." || segment.endsWith(".lock"))
  );
};

const validCanonicalPath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 8_192 &&
  isAbsolute(value) &&
  resolve(value) === value &&
  !value.includes("\\") &&
  !/[\u0000-\u001f\u007f]/u.test(value) &&
  !containsSensitiveMaterial(value);

export const deriveRepositoryDigest = (
  repositoryIdentity: string,
  repositoryCommonDirectory: string,
  failureCode: EnvironmentRegistryErrorCode
): string => {
  const match = LOCAL_REPOSITORY_IDENTITY_PATTERN.exec(repositoryIdentity);
  const computed = createHash("sha256").update(repositoryCommonDirectory, "utf8").digest("hex");
  if (match?.[1] !== computed) throw new OwnedEnvironmentRegistryError(failureCode);
  return computed;
};

const admitAuthorization = (
  value: unknown,
  binding: {
    readonly workspaceId: WorkspaceId;
    readonly runId: RunId;
    readonly environmentId: EnvironmentId;
    readonly repositoryIdentity: string;
    readonly sourceCommit: string;
    readonly branch: string;
  },
  failureCode: EnvironmentRegistryErrorCode
): EnvironmentAuthorization => {
  let parsed: ReturnType<typeof EnvironmentAuthorizationSchema.safeParse>;
  try {
    parsed = EnvironmentAuthorizationSchema.safeParse(value);
  } catch {
    throw new OwnedEnvironmentRegistryError(failureCode);
  }
  if (!parsed.success) throw new OwnedEnvironmentRegistryError(failureCode);
  let digest: string;
  try {
    digest = createHash("sha256")
      .update(canonicalizeEnvironmentAuthorizationForDigest(parsed.data), "utf8")
      .digest("hex");
  } catch {
    throw new OwnedEnvironmentRegistryError(failureCode);
  }
  const scope = parsed.data.scope;
  if (
    parsed.data.digest !== digest ||
    scope.workspaceId !== binding.workspaceId ||
    scope.runId !== binding.runId ||
    scope.environmentId !== binding.environmentId ||
    scope.repositoryIdentity !== binding.repositoryIdentity ||
    scope.sourceCommit !== binding.sourceCommit ||
    scope.branch !== binding.branch ||
    containsSensitiveMaterial(scope.cwdRoot)
  ) {
    throw new OwnedEnvironmentRegistryError(failureCode);
  }
  const allowedCredentialRefIds = [...scope.allowedCredentialRefIds];
  Object.freeze(allowedCredentialRefIds);
  return Object.freeze({
    ...parsed.data,
    scope: Object.freeze({
      ...scope,
      resourceLimits: Object.freeze({ ...scope.resourceLimits }),
      allowedCredentialRefIds
    })
  });
};

export const snapshotInput = (
  candidate: EnvironmentIntentInput,
  requireExactKeys = true,
  failureCode: EnvironmentRegistryErrorCode = "invalid_input"
): EnvironmentIntentInput => {
  let workspaceId: unknown;
  let runId: unknown;
  let environmentId: unknown;
  let repositoryIdentity: unknown;
  let canonicalSourcePath: unknown;
  let repositoryCommonDirectory: unknown;
  let sourceCommit: unknown;
  let branch: unknown;
  let safeConfigDigest: unknown;
  let authorization: unknown;
  let prepareRequestDigest: unknown;
  try {
    if (
      !isRecord(candidate) ||
      (requireExactKeys &&
        !hasExactKeys(candidate, [
          "workspaceId",
          "runId",
          "environmentId",
          "repositoryIdentity",
          "canonicalSourcePath",
          "repositoryCommonDirectory",
          "sourceCommit",
          "branch",
          "safeConfigDigest",
          "authorization",
          "prepareRequestDigest"
        ]))
    ) {
      throw new TypeError();
    }
    workspaceId = candidate.workspaceId;
    runId = candidate.runId;
    environmentId = candidate.environmentId;
    repositoryIdentity = candidate.repositoryIdentity;
    canonicalSourcePath = candidate.canonicalSourcePath;
    repositoryCommonDirectory = candidate.repositoryCommonDirectory;
    sourceCommit = candidate.sourceCommit;
    branch = candidate.branch;
    safeConfigDigest = candidate.safeConfigDigest;
    authorization = candidate.authorization;
    prepareRequestDigest = candidate.prepareRequestDigest;
  } catch {
    throw new OwnedEnvironmentRegistryError(failureCode);
  }
  const parsedWorkspaceId = WorkspaceIdSchema.safeParse(workspaceId);
  const parsedRunId = RunIdSchema.safeParse(runId);
  const parsedEnvironmentId = EnvironmentIdSchema.safeParse(environmentId);
  const parsedRepositoryIdentity =
    SafeMetadataStringSchema.max(1_024).safeParse(repositoryIdentity);
  if (
    !parsedWorkspaceId.success ||
    !parsedRunId.success ||
    !parsedEnvironmentId.success ||
    !parsedRepositoryIdentity.success ||
    !validCanonicalPath(canonicalSourcePath) ||
    !validCanonicalPath(repositoryCommonDirectory) ||
    typeof sourceCommit !== "string" ||
    !COMMIT_PATTERN.test(sourceCommit) ||
    typeof branch !== "string" ||
    !validBranch(branch) ||
    typeof safeConfigDigest !== "string" ||
    !SHA256_PATTERN.test(safeConfigDigest) ||
    typeof prepareRequestDigest !== "string" ||
    !SHA256_PATTERN.test(prepareRequestDigest)
  ) {
    throw new OwnedEnvironmentRegistryError(failureCode);
  }
  deriveRepositoryDigest(parsedRepositoryIdentity.data, repositoryCommonDirectory, failureCode);
  const admittedAuthorization = admitAuthorization(
    authorization,
    {
      workspaceId: parsedWorkspaceId.data,
      runId: parsedRunId.data,
      environmentId: parsedEnvironmentId.data,
      repositoryIdentity: parsedRepositoryIdentity.data,
      sourceCommit,
      branch
    },
    failureCode
  );
  return Object.freeze({
    workspaceId: parsedWorkspaceId.data,
    runId: parsedRunId.data,
    environmentId: parsedEnvironmentId.data,
    repositoryIdentity: parsedRepositoryIdentity.data,
    canonicalSourcePath,
    repositoryCommonDirectory,
    sourceCommit,
    branch,
    safeConfigDigest,
    authorization: admittedAuthorization,
    prepareRequestDigest
  });
};

export const parseIntent = (value: unknown): EnvironmentIntent => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "kind",
      "workspaceId",
      "runId",
      "environmentId",
      "repositoryIdentity",
      "canonicalSourcePath",
      "repositoryCommonDirectory",
      "repositoryDigest",
      "sourceCommit",
      "branch",
      "safeConfigDigest",
      "authorization",
      "authorizationDigest",
      "prepareRequestDigest",
      "managedPath",
      "creationAttemptId",
      "intentDigest"
    ]) ||
    value.version !== 1 ||
    value.kind !== "environment_intent" ||
    typeof value.repositoryDigest !== "string" ||
    !SHA256_PATTERN.test(value.repositoryDigest) ||
    typeof value.managedPath !== "string" ||
    typeof value.creationAttemptId !== "string" ||
    !ATTEMPT_PATTERN.test(value.creationAttemptId) ||
    typeof value.intentDigest !== "string" ||
    !SHA256_PATTERN.test(value.intentDigest)
  ) {
    throw new OwnedEnvironmentRegistryError("maintenance_required");
  }
  const admitted = snapshotInput(
    value as unknown as EnvironmentIntentInput,
    false,
    "maintenance_required"
  );
  const repositoryDigest = deriveRepositoryDigest(
    admitted.repositoryIdentity,
    admitted.repositoryCommonDirectory,
    "maintenance_required"
  );
  if (value.repositoryDigest !== repositoryDigest) {
    throw new OwnedEnvironmentRegistryError("maintenance_required");
  }
  if (value.authorizationDigest !== admitted.authorization.digest) {
    throw new OwnedEnvironmentRegistryError("maintenance_required");
  }
  const withoutDigest: IntentWithoutDigest = {
    version: 1,
    kind: "environment_intent",
    ...admitted,
    repositoryDigest,
    authorizationDigest: admitted.authorization.digest,
    managedPath: value.managedPath,
    creationAttemptId: value.creationAttemptId
  };
  if (digestRecord("autostack.environment-intent.v1", withoutDigest) !== value.intentDigest) {
    throw new OwnedEnvironmentRegistryError("maintenance_required");
  }
  return Object.freeze({ ...withoutDigest, intentDigest: value.intentDigest });
};

export const PHASES = Object.freeze([
  { phase: "intent_recorded" as const, sequence: 1 as const },
  { phase: "worktree_added" as const, sequence: 2 as const },
  { phase: "ready" as const, sequence: 3 as const },
  { phase: "disposal_recorded" as const, sequence: 4 as const },
  { phase: "disposed" as const, sequence: 5 as const }
]);

export const intentRelative = (environmentId: EnvironmentId): string =>
  `environments/${environmentIdComponent(environmentId)}.json`;

export const phaseRelative = (
  environmentId: EnvironmentId,
  sequence: 1 | 2 | 3 | 4 | 5
): string => {
  const phase = PHASES[sequence - 1];
  if (phase === undefined) throw new OwnedEnvironmentRegistryError("invalid_transition");
  return `environments/journal/${environmentIdComponent(environmentId)}/0${String(sequence)}-${phase.phase.replaceAll("_", "-")}.json`;
};

export const parseEvidence = (value: unknown): EnvironmentPhaseEvidence => {
  const isDisposalPhase = isRecord(value) && (value.sequence === 4 || value.sequence === 5);
  const isDisposedPhase = isRecord(value) && value.sequence === 5;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "kind",
      "phase",
      "sequence",
      "environmentId",
      "creationAttemptId",
      "intentDigest",
      "previousEvidenceDigest",
      "recordedAt",
      ...(isDisposalPhase
        ? ([
            "disposalRequestDigest",
            "environmentAuthorizationId",
            "environmentAuthorizationDigest",
            "terminalRunEvidence"
          ] as const)
        : []),
      ...(isDisposedPhase
        ? (["worktreeListDigest", "retainedBranchCommit", "verifiedAt"] as const)
        : []),
      "evidenceDigest"
    ]) ||
    value.version !== 1 ||
    value.kind !== "environment_phase" ||
    !PHASES.some((entry) => entry.phase === value.phase && entry.sequence === value.sequence) ||
    (value.sequence === 1
      ? value.previousEvidenceDigest !== null
      : typeof value.previousEvidenceDigest !== "string" ||
        !SHA256_PATTERN.test(value.previousEvidenceDigest)) ||
    typeof value.creationAttemptId !== "string" ||
    !ATTEMPT_PATTERN.test(value.creationAttemptId) ||
    typeof value.intentDigest !== "string" ||
    !SHA256_PATTERN.test(value.intentDigest) ||
    !isCanonicalTimestamp(value.recordedAt) ||
    (isDisposalPhase &&
      (typeof value.disposalRequestDigest !== "string" ||
        !SHA256_PATTERN.test(value.disposalRequestDigest) ||
        typeof value.environmentAuthorizationDigest !== "string" ||
        !SHA256_PATTERN.test(value.environmentAuthorizationDigest))) ||
    (isDisposedPhase &&
      (typeof value.worktreeListDigest !== "string" ||
        !SHA256_PATTERN.test(value.worktreeListDigest) ||
        typeof value.retainedBranchCommit !== "string" ||
        !COMMIT_PATTERN.test(value.retainedBranchCommit) ||
        !isCanonicalTimestamp(value.verifiedAt))) ||
    typeof value.evidenceDigest !== "string" ||
    !SHA256_PATTERN.test(value.evidenceDigest)
  ) {
    throw new OwnedEnvironmentRegistryError("maintenance_required");
  }
  const environmentId = EnvironmentIdSchema.safeParse(value.environmentId);
  const environmentAuthorizationId = isDisposalPhase
    ? EnvironmentAuthorizationIdSchema.safeParse(value.environmentAuthorizationId)
    : undefined;
  const terminalRunEvidence = isDisposalPhase
    ? TerminalRunEvidenceSchema.safeParse(value.terminalRunEvidence)
    : undefined;
  if (
    !environmentId.success ||
    (isDisposalPhase &&
      (environmentAuthorizationId?.success !== true || terminalRunEvidence?.success !== true))
  ) {
    throw new OwnedEnvironmentRegistryError("maintenance_required");
  }
  const withoutDigest: EvidenceWithoutDigest = {
    version: 1,
    kind: "environment_phase",
    phase: value.phase as EnvironmentPhase,
    sequence: value.sequence as 1 | 2 | 3 | 4 | 5,
    environmentId: environmentId.data,
    creationAttemptId: value.creationAttemptId,
    intentDigest: value.intentDigest,
    previousEvidenceDigest: value.previousEvidenceDigest as string | null,
    recordedAt: value.recordedAt,
    ...(isDisposalPhase
      ? {
          disposalRequestDigest: value.disposalRequestDigest as string,
          environmentAuthorizationId:
            environmentAuthorizationId?.data as EnvironmentAuthorizationId,
          environmentAuthorizationDigest: value.environmentAuthorizationDigest as string,
          terminalRunEvidence: Object.freeze(terminalRunEvidence?.data as TerminalRunEvidence)
        }
      : {}),
    ...(isDisposedPhase
      ? {
          worktreeListDigest: value.worktreeListDigest as string,
          retainedBranchCommit: value.retainedBranchCommit as string,
          verifiedAt: value.verifiedAt as string
        }
      : {})
  };
  if (digestRecord("autostack.environment-phase.v1", withoutDigest) !== value.evidenceDigest) {
    throw new OwnedEnvironmentRegistryError("maintenance_required");
  }
  return Object.freeze({ ...withoutDigest, evidenceDigest: value.evidenceDigest });
};
