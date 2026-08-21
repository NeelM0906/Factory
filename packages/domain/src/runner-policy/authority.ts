import {
  ApprovalSchema,
  CommandAuthorizationSchema,
  EnvironmentAuthorizationSchema,
  RunSchema,
  canonicalizeCommandAuthorizationForDigest,
  canonicalizeEnvironmentAuthorizationForDigest,
  digestCommandAuthorization,
  digestCommandScope,
  digestEnvironmentAuthorization,
  digestExecutionScope,
  validateCommandAuthorizationAgainstEnvironment,
  type Approval,
  type CommandAuthorization,
  type EnvironmentAuthorization,
  type Run,
  type WorkspaceId
} from "@autostack/contracts";

import { approvalInstant, authorizationInstant, authorizationLifetime } from "./core.js";
import { allowed, rejected, type ExecutionPolicyAuthority, type PolicyDecision } from "./types.js";

export const resolveById = async <Value>(
  expectedId: string,
  resolve: () => Promise<unknown>,
  parse: (candidate: unknown) => Value,
  identify: (record: Value) => string
): Promise<PolicyDecision<Value>> => {
  const candidate = await resolve();
  if (candidate === undefined || candidate === null) return rejected("record_not_found");
  const record = parse(candidate);
  return identify(record) === expectedId ? allowed(record) : rejected("record_identity_mismatch");
};

export const sameEnvironmentAuthorization = async (
  left: EnvironmentAuthorization,
  right: EnvironmentAuthorization
): Promise<boolean> =>
  left.digest === (await digestEnvironmentAuthorization(left)) &&
  right.digest === (await digestEnvironmentAuthorization(right)) &&
  canonicalizeEnvironmentAuthorizationForDigest(left) ===
    canonicalizeEnvironmentAuthorizationForDigest(right);

export const sameCommandAuthorization = async (
  left: CommandAuthorization,
  right: CommandAuthorization
): Promise<boolean> =>
  left.digest === (await digestCommandAuthorization(left)) &&
  right.digest === (await digestCommandAuthorization(right)) &&
  canonicalizeCommandAuthorizationForDigest(left) ===
    canonicalizeCommandAuthorizationForDigest(right);

interface ApprovalVerification {
  readonly run: Run;
  readonly workspaceId: WorkspaceId;
  readonly kind: Approval["kind"];
  readonly evidenceDigest: string;
  readonly now: string;
}

export const validateApproval = (
  approval: Approval,
  verification: ApprovalVerification
): PolicyDecision<Approval> => {
  if (
    verification.workspaceId !== verification.run.workspaceId ||
    approval.workspaceId !== verification.run.workspaceId
  ) {
    return rejected("workspace_mismatch");
  }
  if (approval.runId !== verification.run.id) return rejected("run_mismatch");
  if (approval.kind !== verification.kind) return rejected("approval_kind_mismatch");
  if (approval.status === "stale") return rejected("approval_stale");
  if (approval.status !== "approved") return rejected("approval_not_approved");
  if (approval.decision?.decision !== "approved") return rejected("approval_invalid");
  if (!approval.eligibleApproverIds.includes(approval.decision.actor.id)) {
    return rejected("approval_ineligible");
  }
  const chronology = approvalChronology(approval, verification.now);
  if (chronology === "invalid") return rejected("approval_invalid");
  if (chronology === "stale") return rejected("approval_stale");
  return approval.evidenceDigest === verification.evidenceDigest
    ? allowed(approval)
    : rejected("approval_evidence_mismatch");
};

const approvalChronology = (approval: Approval, now: string): "valid" | "invalid" | "stale" => {
  if (approval.decision === undefined) return "invalid";
  const created = approvalInstant(approval.createdAt);
  const decided = approvalInstant(approval.decision.decidedAt);
  const updated = approvalInstant(approval.updatedAt);
  const current = authorizationInstant(now);
  if (
    created === undefined ||
    decided === undefined ||
    updated === undefined ||
    current === undefined
  ) {
    return "invalid";
  }
  if (created > decided || decided !== updated) return "invalid";
  return updated > current ? "stale" : "valid";
};

export const resolveApproval = (
  authority: ExecutionPolicyAuthority,
  approvalId: Approval["id"]
): Promise<PolicyDecision<Approval>> =>
  resolveById(
    approvalId,
    () => authority.resolveApproval(approvalId),
    ApprovalSchema.parse,
    (approval) => approval.id
  );

export const validateTrustedEnvironmentAuthorization = async (
  authority: ExecutionPolicyAuthority,
  environment: EnvironmentAuthorization,
  run: Run,
  workspaceId: WorkspaceId,
  now: string,
  enforceExpiry: boolean
): Promise<PolicyDecision<EnvironmentAuthorization>> => {
  if (environment.digest !== (await digestEnvironmentAuthorization(environment))) {
    return rejected("authorization_mismatch");
  }
  const evidenceDigest = await digestExecutionScope(environment.scope);
  if (environment.approvalEvidenceDigest !== evidenceDigest) {
    return rejected("approval_evidence_mismatch");
  }
  const lifetime = authorizationLifetime(environment, now, enforceExpiry);
  if (!lifetime.ok) return lifetime;
  const approval = await resolveApproval(authority, environment.approvalId);
  if (!approval.ok) return approval;
  const validated = validateApproval(approval.value, {
    run,
    workspaceId,
    kind: "plan",
    evidenceDigest,
    now
  });
  if (!validated.ok) return validated;
  if (environment.scope.workspaceId !== run.workspaceId) return rejected("workspace_mismatch");
  return environment.scope.runId === run.id ? allowed(environment) : rejected("run_mismatch");
};

export const validateTrustedCommandAuthorization = async (
  authority: ExecutionPolicyAuthority,
  command: CommandAuthorization,
  environment: EnvironmentAuthorization,
  run: Run,
  workspaceId: WorkspaceId,
  now: string
): Promise<PolicyDecision<CommandAuthorization>> => {
  if (command.digest !== (await digestCommandAuthorization(command))) {
    return rejected("authorization_mismatch");
  }
  const evidenceDigest = await digestCommandScope(command.scope);
  if (command.approvalEvidenceDigest !== evidenceDigest) {
    return rejected("approval_evidence_mismatch");
  }
  const lifetime = authorizationLifetime(command, now, true);
  if (!lifetime.ok) return lifetime;
  const approval = await resolveApproval(authority, command.approvalId);
  if (!approval.ok) return approval;
  const validated = validateApproval(approval.value, {
    run,
    workspaceId,
    kind: "permission",
    evidenceDigest,
    now
  });
  if (!validated.ok) return validated;
  return commandMatchesEnvironment(command, environment);
};

const commandMatchesEnvironment = (
  command: CommandAuthorization,
  environment: EnvironmentAuthorization
): PolicyDecision<CommandAuthorization> => {
  if (
    command.scope.environmentAuthorizationId !== environment.id ||
    command.scope.environmentAuthorizationDigest !== environment.digest
  ) {
    return rejected("authorization_mismatch");
  }
  try {
    validateCommandAuthorizationAgainstEnvironment(command, environment);
    return allowed(command);
  } catch {
    return rejected("command_scope_broadened");
  }
};

export const resolveRun = (
  authority: ExecutionPolicyAuthority,
  runId: Run["id"]
): Promise<PolicyDecision<Run>> =>
  resolveById(
    runId,
    () => authority.resolveRun(runId),
    RunSchema.parse,
    (run) => run.id
  );

export const resolveEnvironmentAuthorization = (
  authority: ExecutionPolicyAuthority,
  authorizationId: EnvironmentAuthorization["id"]
): Promise<PolicyDecision<EnvironmentAuthorization>> =>
  resolveById(
    authorizationId,
    () => authority.resolveEnvironmentAuthorization(authorizationId),
    EnvironmentAuthorizationSchema.parse,
    (authorization) => authorization.id
  );

export const resolveCommandAuthorization = (
  authority: ExecutionPolicyAuthority,
  authorizationId: CommandAuthorization["id"]
): Promise<PolicyDecision<CommandAuthorization>> =>
  resolveById(
    authorizationId,
    () => authority.resolveCommandAuthorization(authorizationId),
    CommandAuthorizationSchema.parse,
    (authorization) => authorization.id
  );
