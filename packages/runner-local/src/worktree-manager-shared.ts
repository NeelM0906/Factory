import { createHash } from "node:crypto";

import {
  PreparedEnvironmentSchema,
  canonicalizeVersionedDigestValue,
  type EnvironmentId,
  type PreparedEnvironment,
  type TerminalRunEvidence
} from "@autostack/contracts";

import type {
  EnvironmentPhaseEvidence,
  EnvironmentRegistryPublicationBoundary,
  EnvironmentRegistryState
} from "./environment-registry.js";
import type { GitProcessRunner, GitWorktreeRecord, InspectedGitRepository } from "./git-client.js";

export type WorktreeManagerErrorCode =
  | "invalid_request"
  | "root_busy"
  | "closed"
  | "active_commands"
  | "terminal_evidence_invalid"
  | "dirty_worktree"
  | "environment_conflict"
  | "maintenance_required"
  | "unsafe_process_state"
  | "unsafe_state";

const ERROR_MESSAGES = Object.freeze({
  invalid_request: "The worktree request is invalid.",
  root_busy: "The AutoStack data root is busy.",
  closed: "The worktree manager is closed.",
  active_commands: "The environment has active commands.",
  terminal_evidence_invalid: "The terminal run evidence is invalid.",
  dirty_worktree: "The managed worktree has uncommitted changes.",
  environment_conflict: "The environment conflicts with durable Git state.",
  maintenance_required: "The managed worktree state requires maintenance.",
  unsafe_process_state: "The Git process state is unsafe.",
  unsafe_state: "The worktree operation failed safely."
} satisfies Readonly<Record<WorktreeManagerErrorCode, string>>);

export class WorktreeManagerError extends Error {
  readonly code: WorktreeManagerErrorCode;

  constructor(code: WorktreeManagerErrorCode) {
    const admitted = Object.hasOwn(ERROR_MESSAGES, code) ? code : "unsafe_state";
    super(ERROR_MESSAGES[admitted]);
    this.name = "WorktreeManagerError";
    this.code = admitted;
    Object.freeze(this);
  }
}

export interface EnvironmentQuiescenceLease {
  close(): Promise<void> | void;
}

export interface TerminalEvidenceVerification {
  readonly workspaceId: string;
  readonly runId: string;
  readonly environmentId: EnvironmentId;
  readonly environmentAuthorizationId: string;
  readonly environmentAuthorizationDigest: string;
  readonly terminalRunEvidence: TerminalRunEvidence;
}

export interface ResolvedPreparedEnvironment {
  readonly environment: PreparedEnvironment;
  readonly managedPath: string;
  readonly intentDigest: string;
}

export type WorktreeManagerDisposalBoundary =
  | "before_ready_source_revalidation"
  | "after_disposal_recorded"
  | "before_final_source_revalidation"
  | "after_worktree_unlock"
  | "after_worktree_remove"
  | "before_disposed_publication";

export interface WorktreeManagerOptions {
  readonly dataRoot: string;
  readonly now: () => string;
  readonly deferStartupDisposal?: boolean;
  readonly verifyTerminalEvidence: (
    verification: TerminalEvidenceVerification
  ) => Promise<boolean> | boolean;
  readonly acquireEnvironmentQuiescence: (
    environmentId: EnvironmentId
  ) => Promise<EnvironmentQuiescenceLease | undefined> | EnvironmentQuiescenceLease | undefined;
  /** Explicit trusted dependency for portable tests; production omits it. */
  readonly trustedGitExecutable?: string;
  /** Deterministic reviewed process boundary used only for quarantine tests. */
  readonly gitProcessRunner?: GitProcessRunner;
  /** Deterministic registry publication boundary used only by crash tests. */
  readonly onRegistryBoundary?: (
    boundary: EnvironmentRegistryPublicationBoundary
  ) => Promise<void> | void;
  /** Deterministic creation-attempt source used only by crash tests. */
  readonly createAttemptId?: () => string;
  /** Deterministic disposal race boundary used only by crash/race tests. */
  readonly onDisposalBoundary?: (boundary: WorktreeManagerDisposalBoundary) => Promise<void> | void;
}

export interface AdmittedWorktreeManagerOptions {
  readonly dataRoot: string;
  readonly now: () => string;
  readonly deferStartupDisposal: boolean;
  readonly verifyTerminalEvidence: (verification: TerminalEvidenceVerification) => Promise<boolean>;
  readonly acquireEnvironmentQuiescence: (
    environmentId: EnvironmentId
  ) => Promise<EnvironmentQuiescenceLease | undefined>;
  readonly trustedGitExecutable?: string;
  readonly gitProcessRunner?: GitProcessRunner;
  readonly onRegistryBoundary?: (
    boundary: EnvironmentRegistryPublicationBoundary
  ) => Promise<void> | void;
  readonly createAttemptId?: () => string;
  readonly onDisposalBoundary: (boundary: WorktreeManagerDisposalBoundary) => Promise<void>;
}

const exactOwnKeys = (value: object, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

export const snapshotManagerOptions = (
  candidate: WorktreeManagerOptions
): AdmittedWorktreeManagerOptions => {
  let dataRoot: unknown;
  let now: unknown;
  let deferStartupDisposal: unknown;
  let verifyTerminalEvidence: unknown;
  let acquireEnvironmentQuiescence: unknown;
  let trustedGitExecutable: unknown;
  let gitProcessRunner: unknown;
  let gitProcessRunnerRun: unknown;
  let onRegistryBoundary: unknown;
  let createAttemptId: unknown;
  let onDisposalBoundary: unknown;
  try {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !exactOwnKeys(candidate, [
        "dataRoot",
        "now",
        "deferStartupDisposal",
        "verifyTerminalEvidence",
        "acquireEnvironmentQuiescence",
        "trustedGitExecutable",
        "gitProcessRunner",
        "onRegistryBoundary",
        "createAttemptId",
        "onDisposalBoundary"
      ])
    ) {
      throw new TypeError();
    }
    dataRoot = candidate.dataRoot;
    now = candidate.now;
    deferStartupDisposal = candidate.deferStartupDisposal;
    verifyTerminalEvidence = candidate.verifyTerminalEvidence;
    acquireEnvironmentQuiescence = candidate.acquireEnvironmentQuiescence;
    trustedGitExecutable = candidate.trustedGitExecutable;
    gitProcessRunner = candidate.gitProcessRunner;
    if (gitProcessRunner !== undefined) {
      if (typeof gitProcessRunner !== "object" || gitProcessRunner === null) throw new TypeError();
      gitProcessRunnerRun = (gitProcessRunner as { readonly run?: unknown }).run;
    }
    onRegistryBoundary = candidate.onRegistryBoundary;
    createAttemptId = candidate.createAttemptId;
    onDisposalBoundary = candidate.onDisposalBoundary;
  } catch {
    throw new WorktreeManagerError("invalid_request");
  }
  if (
    typeof dataRoot !== "string" ||
    !dataRoot.startsWith("/") ||
    typeof now !== "function" ||
    (deferStartupDisposal !== undefined && typeof deferStartupDisposal !== "boolean") ||
    typeof verifyTerminalEvidence !== "function" ||
    typeof acquireEnvironmentQuiescence !== "function" ||
    (trustedGitExecutable !== undefined && typeof trustedGitExecutable !== "string") ||
    (gitProcessRunner !== undefined && typeof gitProcessRunnerRun !== "function") ||
    (onRegistryBoundary !== undefined && typeof onRegistryBoundary !== "function") ||
    (createAttemptId !== undefined && typeof createAttemptId !== "function") ||
    (onDisposalBoundary !== undefined && typeof onDisposalBoundary !== "function")
  ) {
    throw new WorktreeManagerError("invalid_request");
  }
  const nowFunction = now as () => string;
  const verifier = verifyTerminalEvidence as (
    verification: TerminalEvidenceVerification
  ) => Promise<boolean> | boolean;
  const quiescence = acquireEnvironmentQuiescence as (
    environmentId: EnvironmentId
  ) => Promise<EnvironmentQuiescenceLease | undefined> | EnvironmentQuiescenceLease | undefined;
  const disposalBoundary = onDisposalBoundary as
    ((boundary: WorktreeManagerDisposalBoundary) => Promise<void> | void) | undefined;
  const processRunner = gitProcessRunner as GitProcessRunner | undefined;
  const processRunnerRun = gitProcessRunnerRun as GitProcessRunner["run"] | undefined;
  return Object.freeze({
    dataRoot,
    now: () => Reflect.apply(nowFunction, undefined, []) as string,
    deferStartupDisposal: deferStartupDisposal === true,
    verifyTerminalEvidence: async (verification: TerminalEvidenceVerification) =>
      (await Reflect.apply(verifier, undefined, [verification])) as boolean,
    acquireEnvironmentQuiescence: async (environmentId: EnvironmentId) =>
      (await Reflect.apply(quiescence, undefined, [environmentId])) as
        EnvironmentQuiescenceLease | undefined,
    onDisposalBoundary: async (boundary: WorktreeManagerDisposalBoundary) => {
      if (disposalBoundary !== undefined) {
        await Reflect.apply(disposalBoundary, undefined, [boundary]);
      }
    },
    ...(trustedGitExecutable === undefined ? {} : { trustedGitExecutable }),
    ...(gitProcessRunner === undefined
      ? {}
      : {
          gitProcessRunner: Object.freeze({
            run: (request: Parameters<GitProcessRunner["run"]>[0]) =>
              Reflect.apply(processRunnerRun!, processRunner, [request]) as ReturnType<
                GitProcessRunner["run"]
              >
          })
        }),
    ...(onRegistryBoundary === undefined
      ? {}
      : {
          onRegistryBoundary: onRegistryBoundary as NonNullable<
            AdmittedWorktreeManagerOptions["onRegistryBoundary"]
          >
        }),
    ...(createAttemptId === undefined
      ? {}
      : {
          createAttemptId: createAttemptId as NonNullable<
            AdmittedWorktreeManagerOptions["createAttemptId"]
          >
        })
  });
};

export const digestManagerValue = (domain: string, value: unknown): string =>
  createHash("sha256")
    .update(canonicalizeVersionedDigestValue(domain, value), "utf8")
    .digest("hex");

export const deepFreezeManagerValue = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreezeManagerValue(nested);
  return Object.freeze(value);
};

export const preparedFromRegistryState = (state: EnvironmentRegistryState): PreparedEnvironment => {
  const ready = state.evidence[2];
  if (ready?.phase !== "ready") throw new WorktreeManagerError("maintenance_required");
  return deepFreezeManagerValue(
    PreparedEnvironmentSchema.parse({
      environmentId: state.intent.environmentId,
      workspaceId: state.intent.workspaceId,
      runId: state.intent.runId,
      repositoryIdentity: state.intent.repositoryIdentity,
      sourceCommit: state.intent.sourceCommit,
      branch: state.intent.branch,
      authorization: state.intent.authorization,
      state: "prepared",
      preparedAt: ready.recordedAt
    })
  );
};

export const resolvedPreparedFromState = (
  state: EnvironmentRegistryState
): ResolvedPreparedEnvironment =>
  Object.freeze({
    environment: preparedFromRegistryState(state),
    managedPath: state.intent.managedPath,
    intentDigest: state.intent.intentDigest
  });

export const inspectionMatchesIntent = (
  actual: InspectedGitRepository,
  state: EnvironmentRegistryState
): boolean =>
  actual.inspection.repositoryIdentity === state.intent.repositoryIdentity &&
  actual.inspection.canonicalSourcePath === state.intent.canonicalSourcePath &&
  actual.inspection.repositoryCommonDirectory === state.intent.repositoryCommonDirectory &&
  actual.inspection.sourceCommit === state.intent.sourceCommit &&
  actual.safeConfigDigest === state.intent.safeConfigDigest;

export const exactTargetRecord = (
  records: readonly GitWorktreeRecord[],
  state: EnvironmentRegistryState
): GitWorktreeRecord | undefined => {
  const expectedBranch = `refs/heads/${state.intent.branch}`;
  const matches = records.filter(
    (record) => record.path === state.intent.managedPath || record.branch === expectedBranch
  );
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) throw new WorktreeManagerError("environment_conflict");
  const record = matches[0];
  if (
    record === undefined ||
    record.path !== state.intent.managedPath ||
    record.branch !== expectedBranch
  ) {
    throw new WorktreeManagerError("environment_conflict");
  }
  return record;
};

export const assertTargetRecord = (
  record: GitWorktreeRecord,
  state: EnvironmentRegistryState,
  allowUnlocked = false
): void => {
  if (
    record.head !== state.intent.sourceCommit ||
    record.bare ||
    record.detached ||
    record.prunableReason !== undefined ||
    (!allowUnlocked && record.lockedReason !== "AutoStack") ||
    (allowUnlocked && record.lockedReason !== undefined && record.lockedReason !== "AutoStack")
  ) {
    throw new WorktreeManagerError("environment_conflict");
  }
};

export const disposalEvidenceFromState = (
  state: EnvironmentRegistryState
): EnvironmentPhaseEvidence => {
  const evidence = state.evidence[3];
  if (
    evidence?.phase !== "disposal_recorded" ||
    evidence.environmentAuthorizationId === undefined ||
    evidence.environmentAuthorizationDigest === undefined ||
    evidence.terminalRunEvidence === undefined ||
    evidence.disposalRequestDigest === undefined
  ) {
    throw new WorktreeManagerError("maintenance_required");
  }
  return evidence;
};
