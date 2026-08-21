import type {
  Approval,
  ArtifactDescriptor,
  CommandAuthorization,
  EnvironmentAuthorization,
  Run,
  TerminalRunEvidence,
  WorkspaceId
} from "@autostack/contracts";

export type RunnerPolicyRejectionCode =
  | "invalid_input"
  | "record_not_found"
  | "record_identity_mismatch"
  | "workspace_mismatch"
  | "run_mismatch"
  | "environment_mismatch"
  | "command_mismatch"
  | "approval_kind_mismatch"
  | "approval_not_approved"
  | "approval_ineligible"
  | "approval_stale"
  | "approval_invalid"
  | "approval_evidence_mismatch"
  | "authorization_mismatch"
  | "authorization_expired"
  | "run_state_mismatch"
  | "command_scope_mismatch"
  | "command_scope_broadened"
  | "cwd_outside_scope"
  | "timeout_exceeds_limit"
  | "credential_not_allowed"
  | "artifact_mismatch"
  | "active_command"
  | "operator_required"
  | "terminal_evidence_mismatch";

export type PolicyDecision<Value> =
  | Readonly<{ readonly ok: true; readonly value: Value }>
  | Readonly<{ readonly ok: false; readonly code: RunnerPolicyRejectionCode }>;

export type Immutable<Value> = Value extends
  string | number | boolean | bigint | symbol | null | undefined
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly Immutable<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: Immutable<Value[Key]> }
      : Value;

export type ImmutableEnvironmentAuthorization = Immutable<EnvironmentAuthorization>;
export type ImmutableCommandAuthorization = Immutable<CommandAuthorization>;

export interface DurableTerminalRunEvidence {
  readonly workspaceId: WorkspaceId;
  readonly runId: Run["id"];
  readonly evidence: TerminalRunEvidence;
}

/** Implementation-neutral authority over persisted control-plane records. */
export interface ExecutionPolicyAuthority {
  readonly resolveRun: (runId: Run["id"]) => Promise<unknown>;
  readonly resolveApproval: (approvalId: Approval["id"]) => Promise<unknown>;
  readonly resolveEnvironmentAuthorization: (
    authorizationId: EnvironmentAuthorization["id"]
  ) => Promise<unknown>;
  readonly resolveCommandAuthorization: (
    authorizationId: CommandAuthorization["id"]
  ) => Promise<unknown>;
  readonly resolveArtifact: (artifactId: ArtifactDescriptor["artifactId"]) => Promise<unknown>;
  readonly resolveTerminalRunEvidence: (runId: Run["id"]) => Promise<unknown>;
  readonly hasActiveCommands: (identity: {
    readonly workspaceId: WorkspaceId;
    readonly runId: Run["id"];
    readonly environmentId: EnvironmentAuthorization["scope"]["environmentId"];
  }) => Promise<boolean>;
}

export const allowed = <Value>(value: Value): PolicyDecision<Value> => ({ ok: true, value });

export const rejected = <Value = never>(
  code: RunnerPolicyRejectionCode
): PolicyDecision<Value> => ({ ok: false, code });
