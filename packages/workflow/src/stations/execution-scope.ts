import { createHash } from "node:crypto";

import {
  CredentialRefIdSchema,
  EnvironmentIdSchema,
  ExecutionScopeSchema,
  InspectRepositoryRequestSchema,
  PLAN_PERMISSION_KINDS,
  PlanPermissionKindSchema,
  RelativeWorkspacePathSchema,
  ResourceLimitsSchema,
  type CredentialRefId,
  type EnvironmentId,
  type ExecutionScope,
  type PlanDocument,
  type RepositoryInspection,
  type RunId,
  type WorkspaceId
} from "@autostack/contracts";
import { z } from "zod";

/**
 * What the composition root knows about a project and a station does not: where the repository
 * lives, what the run may spend, which permission kinds the project has decided are allowed at all,
 * which credential references exist for it, and who may decide its approvals.
 *
 * It is deliberately *configuration* rather than a durable record. Nothing in `@autostack/contracts`
 * describes a project's permission or credential envelope — `ProjectSchema` carries a repository and
 * execution sources only — and inventing a durable public shape belongs to contracts, not here. The
 * consequence a reviewer should hold onto: this object is the **ceiling** a plan is measured
 * against, and it can only ever narrow what the station grants (see `scopeExcessOf`).
 *
 * `eligibleApproverIds` rides along because it answers the same question at the same moment — who
 * the project trusts — and splitting it out would mean threading two configuration objects through
 * one station for no gain.
 */
export const ProjectExecutionConfigurationSchema = z
  .object({
    inspection: InspectRepositoryRequestSchema,
    cwdRoot: RelativeWorkspacePathSchema,
    resourceLimits: ResourceLimitsSchema,
    allowedPermissionKinds: z.array(PlanPermissionKindSchema).max(PLAN_PERMISSION_KINDS.length),
    allowedCredentialRefIds: z.array(CredentialRefIdSchema).max(128),
    eligibleApproverIds: z.array(z.string().trim().min(1).max(240)).min(1).max(200)
  })
  .strict();

export type ProjectExecutionConfiguration = z.infer<typeof ProjectExecutionConfigurationSchema>;

/**
 * The branch an AutoStack run works on, derived from the run id and nothing else.
 *
 * Deriving it from the work item or the repository would let untrusted text choose a Git reference:
 * a title is arbitrary bytes, and `GeneratedBranchSchema` rejecting the malformed ones is not the
 * same as the run owning its own namespace. A `RunId` is `run_<uuid>`, so its suffix is already
 * branch-safe, unique per run, and stable across re-planning — which is what makes the scope digest
 * reproducible at the environment boundary.
 */
export const executionBranchForRun = (runId: RunId): string =>
  `autostack/run/${runId.slice(runId.indexOf("_") + 1)}`;

/**
 * The environment an AutoStack run provisions, derived from the run id and nothing else.
 *
 * `ExecutionScopeShape.environmentId` (`runner.ts:370`) is **inside** the scope, and
 * `digestExecutionScope` covers every field, so the id is part of what a human approves. A freshly
 * minted id therefore cannot work: the plan station digests the scope into the approval and
 * discards it, and the plan-approval decision must later re-derive the *same* scope to record the
 * environment authorization whose `approvalEvidenceDigest` must equal that digest. Mint twice and a
 * valid approval fails `admitPrepareEnvironment` — a stale-approval error with no stale approval.
 *
 * Deriving from a digest rather than reusing the run's own uuid avoids the identifier aliasing that
 * made `stage_<sessionUuid>` wrong: an `EnvironmentId` and a `RunId` sharing a uuid would collide
 * for anything that correlates by uuid.
 *
 * This encodes a Milestone A invariant — **one managed environment per run** — which is also why
 * rework resumes the existing worktree rather than provisioning a second (plan F2). A milestone
 * that allows several environments per run must pass the id explicitly instead of deriving it.
 */
export const executionEnvironmentForRun = (runId: RunId): EnvironmentId => {
  const characters = createHash("sha256")
    .update(`autostack.run-environment:${runId}`, "utf8")
    .digest("hex")
    .slice(0, 32)
    .split("");
  characters[12] = "4";
  characters[16] = "8";
  const value = characters.join("");
  return EnvironmentIdSchema.parse(
    `env_${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
  );
};

export interface ExecutionScopeInput {
  readonly workspaceId: WorkspaceId;
  readonly runId: RunId;
  readonly environmentId: EnvironmentId;
  /** The runner's answer, not the work item's claim: identity and commit come from here. */
  readonly inspection: RepositoryInspection;
  readonly configuration: ProjectExecutionConfiguration;
  /** What the plan asked for — always a subset of the configuration's references. */
  readonly allowedCredentialRefIds: readonly CredentialRefId[];
}

/**
 * The `ExecutionScope` a plan approval is taken over (spec §14.2, plan D1).
 *
 * `normalizeApprovalEvidence("plan", …)` special-cases an `ExecutionScope`, so digesting this value
 * as approval evidence and digesting it as an execution scope produce the same bytes. That is what
 * lets one human approval satisfy both the pipeline gate and `admitPrepareEnvironment`, which
 * recomputes `digestExecutionScope(authorization.scope)` and compares it to the approval's
 * `evidenceDigest`. Every field therefore comes from a source the environment boundary can
 * reproduce: the inspection, the configuration, and the run id.
 */
export const buildExecutionScope = (input: ExecutionScopeInput): ExecutionScope =>
  ExecutionScopeSchema.parse({
    workspaceId: input.workspaceId,
    runId: input.runId,
    environmentId: input.environmentId,
    repositoryIdentity: input.inspection.repositoryIdentity,
    sourceCommit: input.inspection.sourceCommit,
    branch: executionBranchForRun(input.runId),
    cwdRoot: input.configuration.cwdRoot,
    resourceLimits: input.configuration.resourceLimits,
    networkPolicy: "host",
    filesystemDisclosure: "host_user",
    allowedCredentialRefIds: [...input.allowedCredentialRefIds]
  });

/**
 * Names the first way a plan reaches past its project configuration, or `undefined` when it does
 * not. A message rather than a thrown error because exceeding the configuration is a deterministic
 * stage outcome (plan D10), not an exception.
 *
 * The plan body is model output: `PlanPermissionKindSchema` admits all four kinds, so schema
 * validation alone grants everything the enum allows. Only the configuration can say which of them
 * this project permits, and a station that widened the scope from a plan it just read would let
 * repository content authorize its own execution.
 */
export const scopeExcessOf = (
  document: PlanDocument,
  configuration: ProjectExecutionConfiguration
): string | undefined => {
  const permission = document.requiredPermissions.find(
    (required) => !configuration.allowedPermissionKinds.includes(required.kind)
  );
  if (permission !== undefined) {
    return `The project configuration does not allow the ${permission.kind} permission this plan requires.`;
  }
  const credentialRefId = document.requiredCredentialRefIds.find(
    (required) => !configuration.allowedCredentialRefIds.includes(required)
  );
  if (credentialRefId !== undefined) {
    return `The project configuration does not allow credential reference ${credentialRefId}.`;
  }
  return undefined;
};
