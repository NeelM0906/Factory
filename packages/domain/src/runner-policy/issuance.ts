import {
  CommandAuthorizationSchema,
  CommandScopeSchema,
  CommandSpecSchema,
  EnvironmentAuthorizationSchema,
  ExecutionScopeSchema,
  PrepareEnvironmentRequestSchema,
  StartCommandRequestSchema,
  digestCommandAuthorization,
  digestCommandScope,
  digestCommandSpec,
  digestEnvironmentAuthorization,
  digestExecutionScope,
  validateCommandAuthorizationAgainstEnvironment,
  type Approval,
  type CommandAuthorization,
  type CommandScope,
  type CommandSpec,
  type EnvironmentAuthorization,
  type ExecutionScope,
  type PrepareEnvironmentRequest,
  type Run,
  type StartCommandRequest,
  type WorkspaceId
} from "@autostack/contracts";

import {
  resolveApproval,
  resolveCommandAuthorization,
  resolveEnvironmentAuthorization,
  resolveRun,
  sameCommandAuthorization,
  sameEnvironmentAuthorization,
  validateApproval,
  validateTrustedCommandAuthorization,
  validateTrustedEnvironmentAuthorization
} from "./authority.js";
import {
  authorizationLifetime,
  commandScopeAllows,
  immutableCommandAuthorization,
  immutableEnvironmentAuthorization
} from "./core.js";
import {
  allowed,
  rejected,
  type ExecutionPolicyAuthority,
  type ImmutableCommandAuthorization,
  type ImmutableEnvironmentAuthorization,
  type PolicyDecision
} from "./types.js";

export interface IssueEnvironmentAuthorizationInput {
  readonly authority: ExecutionPolicyAuthority;
  readonly authenticatedWorkspaceId: WorkspaceId;
  readonly runId: Run["id"];
  readonly approvalId: Approval["id"];
  readonly scope: unknown;
  readonly authorizationId: EnvironmentAuthorization["id"];
  readonly now: string;
  readonly expiresAt: string;
}

export async function issueEnvironmentAuthorization(
  input: IssueEnvironmentAuthorizationInput
): Promise<PolicyDecision<ImmutableEnvironmentAuthorization>> {
  try {
    return await decideEnvironmentAuthorizationIssue(input);
  } catch {
    return rejected("invalid_input");
  }
}

const decideEnvironmentAuthorizationIssue = async (
  input: IssueEnvironmentAuthorizationInput
): Promise<PolicyDecision<ImmutableEnvironmentAuthorization>> => {
  const scope = ExecutionScopeSchema.parse(input.scope);
  const records = await resolveEnvironmentIssuanceRecords(input);
  if (!records.ok) return records;
  const permitted = await validateEnvironmentIssuance(
    input,
    scope,
    records.value.run,
    records.value.approval
  );
  if (!permitted.ok) return permitted;
  return issueEnvironmentEnvelope(input, scope, records.value.approval.id);
};

const resolveEnvironmentIssuanceRecords = async (
  input: IssueEnvironmentAuthorizationInput
): Promise<PolicyDecision<{ readonly run: Run; readonly approval: Approval }>> => {
  const run = await resolveRun(input.authority, input.runId);
  if (!run.ok) return run;
  const approval = await resolveApproval(input.authority, input.approvalId);
  if (!approval.ok) return approval;
  return allowed({ run: run.value, approval: approval.value });
};

const validateEnvironmentIssuance = async (
  input: IssueEnvironmentAuthorizationInput,
  scope: ExecutionScope,
  run: Run,
  approval: Approval
): Promise<PolicyDecision<void>> => {
  if (input.authenticatedWorkspaceId !== run.workspaceId || scope.workspaceId !== run.workspaceId) {
    return rejected("workspace_mismatch");
  }
  if (scope.runId !== run.id) return rejected("run_mismatch");
  if (run.status !== "provisioning") return rejected("run_state_mismatch");
  const lifetime = authorizationLifetime(
    { createdAt: input.now, expiresAt: input.expiresAt },
    input.now,
    true
  );
  if (!lifetime.ok) return lifetime;
  const validated = validateApproval(approval, {
    run,
    workspaceId: input.authenticatedWorkspaceId,
    kind: "plan",
    evidenceDigest: await digestExecutionScope(scope),
    now: input.now
  });
  return validated.ok ? allowed(undefined) : validated;
};

const issueEnvironmentEnvelope = async (
  input: IssueEnvironmentAuthorizationInput,
  scope: ExecutionScope,
  approvalId: Approval["id"]
): Promise<PolicyDecision<ImmutableEnvironmentAuthorization>> => {
  const approvalEvidenceDigest = await digestExecutionScope(scope);
  const envelope = {
    id: input.authorizationId,
    approvalId,
    approvalEvidenceDigest,
    scope,
    createdAt: input.now,
    expiresAt: input.expiresAt,
    digest: "0".repeat(64)
  };
  const authorization = EnvironmentAuthorizationSchema.parse({
    ...envelope,
    digest: await digestEnvironmentAuthorization(envelope)
  });
  return allowed(immutableEnvironmentAuthorization(authorization));
};

export interface IssueCommandAuthorizationInput {
  readonly authority: ExecutionPolicyAuthority;
  readonly authenticatedWorkspaceId: WorkspaceId;
  readonly runId: Run["id"];
  readonly approvalId: Approval["id"];
  readonly environmentAuthorizationId: EnvironmentAuthorization["id"];
  readonly scope: unknown;
  readonly command: unknown;
  readonly authorizationId: CommandAuthorization["id"];
  readonly now: string;
  readonly expiresAt: string;
}

export async function issueCommandAuthorization(
  input: IssueCommandAuthorizationInput
): Promise<PolicyDecision<ImmutableCommandAuthorization>> {
  try {
    return await decideCommandAuthorizationIssue(input);
  } catch {
    return rejected("invalid_input");
  }
}

interface CommandIssuanceRecords {
  readonly run: Run;
  readonly approval: Approval;
  readonly environment: EnvironmentAuthorization;
}

const decideCommandAuthorizationIssue = async (
  input: IssueCommandAuthorizationInput
): Promise<PolicyDecision<ImmutableCommandAuthorization>> => {
  const scope = CommandScopeSchema.parse(input.scope);
  const command = CommandSpecSchema.parse(input.command);
  const records = await resolveCommandIssuanceRecords(input);
  if (!records.ok) return records;
  const permitted = await validateCommandIssuance(input, scope, command, records.value);
  if (!permitted.ok) return permitted;
  return issueCommandEnvelope(input, scope, records.value.approval.id, records.value.environment);
};

const resolveCommandIssuanceRecords = async (
  input: IssueCommandAuthorizationInput
): Promise<PolicyDecision<CommandIssuanceRecords>> => {
  const run = await resolveRun(input.authority, input.runId);
  if (!run.ok) return run;
  const approval = await resolveApproval(input.authority, input.approvalId);
  if (!approval.ok) return approval;
  const environment = await resolveEnvironmentAuthorization(
    input.authority,
    input.environmentAuthorizationId
  );
  if (!environment.ok) return environment;
  return allowed({ run: run.value, approval: approval.value, environment: environment.value });
};

const validateCommandIssuance = async (
  input: IssueCommandAuthorizationInput,
  scope: CommandScope,
  command: CommandSpec,
  records: CommandIssuanceRecords
): Promise<PolicyDecision<void>> => {
  const ownership = validateCommandIssuanceOwnership(
    input,
    scope,
    records.run,
    records.environment
  );
  if (!ownership.ok) return ownership;
  const environment = await validateTrustedEnvironmentAuthorization(
    input.authority,
    records.environment,
    records.run,
    input.authenticatedWorkspaceId,
    input.now,
    true
  );
  if (!environment.ok) return environment;
  const lifetime = authorizationLifetime(
    { createdAt: input.now, expiresAt: input.expiresAt },
    input.now,
    true
  );
  if (!lifetime.ok) return lifetime;
  if (scope.commandDigest !== (await digestCommandSpec(command)))
    return rejected("command_scope_mismatch");
  const scoped = commandScopeAllows(scope, command);
  if (!scoped.ok) return scoped;
  const approved = validateApproval(records.approval, {
    run: records.run,
    workspaceId: input.authenticatedWorkspaceId,
    kind: "permission",
    evidenceDigest: await digestCommandScope(scope),
    now: input.now
  });
  return approved.ok ? allowed(undefined) : approved;
};

const validateCommandIssuanceOwnership = (
  input: IssueCommandAuthorizationInput,
  scope: CommandScope,
  run: Run,
  environment: EnvironmentAuthorization
): PolicyDecision<void> => {
  if (input.authenticatedWorkspaceId !== run.workspaceId || scope.workspaceId !== run.workspaceId) {
    return rejected("workspace_mismatch");
  }
  if (scope.runId !== run.id || environment.scope.runId !== run.id) return rejected("run_mismatch");
  if (scope.environmentId !== environment.scope.environmentId)
    return rejected("environment_mismatch");
  if (
    scope.environmentAuthorizationId !== environment.id ||
    scope.environmentAuthorizationDigest !== environment.digest
  ) {
    return rejected("authorization_mismatch");
  }
  const validState =
    (scope.action === "implement" && run.status === "implementing") ||
    (scope.action === "verify" && run.status === "verifying");
  return validState ? allowed(undefined) : rejected("run_state_mismatch");
};

const issueCommandEnvelope = async (
  input: IssueCommandAuthorizationInput,
  scope: CommandScope,
  approvalId: Approval["id"],
  environment: EnvironmentAuthorization
): Promise<PolicyDecision<ImmutableCommandAuthorization>> => {
  const approvalEvidenceDigest = await digestCommandScope(scope);
  const envelope = {
    id: input.authorizationId,
    approvalId,
    approvalEvidenceDigest,
    scope,
    createdAt: input.now,
    expiresAt: input.expiresAt,
    digest: "0".repeat(64)
  };
  const authorization = CommandAuthorizationSchema.parse({
    ...envelope,
    digest: await digestCommandAuthorization(envelope)
  });
  try {
    validateCommandAuthorizationAgainstEnvironment(authorization, environment);
    return allowed(immutableCommandAuthorization(authorization));
  } catch {
    return rejected("command_scope_broadened");
  }
};

export interface DecideEnvironmentPreparationInput {
  readonly authority: ExecutionPolicyAuthority;
  readonly authenticatedWorkspaceId: WorkspaceId;
  readonly request: unknown;
  readonly now: string;
}

export async function decideEnvironmentPreparation(
  input: DecideEnvironmentPreparationInput
): Promise<PolicyDecision<PrepareEnvironmentRequest>> {
  try {
    const request = PrepareEnvironmentRequestSchema.parse(input.request);
    return await decidePreparation(input, request);
  } catch {
    return rejected("invalid_input");
  }
}

const decidePreparation = async (
  input: DecideEnvironmentPreparationInput,
  request: PrepareEnvironmentRequest
): Promise<PolicyDecision<PrepareEnvironmentRequest>> => {
  const run = await resolveRun(input.authority, request.runId);
  if (!run.ok) return run;
  const environment = await resolveEnvironmentAuthorization(
    input.authority,
    request.authorization.id
  );
  if (!environment.ok) return environment;
  const ownership = validatePreparationOwnership(
    input.authenticatedWorkspaceId,
    request,
    run.value
  );
  if (!ownership.ok) return ownership;
  if (!(await sameEnvironmentAuthorization(request.authorization, environment.value))) {
    return rejected("authorization_mismatch");
  }
  const trusted = await validateTrustedEnvironmentAuthorization(
    input.authority,
    environment.value,
    run.value,
    input.authenticatedWorkspaceId,
    input.now,
    true
  );
  if (!trusted.ok) return trusted;
  return requestMatchesEnvironment(request, environment.value);
};

const validatePreparationOwnership = (
  workspaceId: WorkspaceId,
  request: PrepareEnvironmentRequest,
  run: Run
): PolicyDecision<void> => {
  if (workspaceId !== run.workspaceId || request.workspaceId !== run.workspaceId) {
    return rejected("workspace_mismatch");
  }
  if (request.runId !== run.id) return rejected("run_mismatch");
  return run.status === "provisioning" ? allowed(undefined) : rejected("run_state_mismatch");
};

const requestMatchesEnvironment = (
  request: PrepareEnvironmentRequest,
  environment: EnvironmentAuthorization
): PolicyDecision<PrepareEnvironmentRequest> => {
  const scope = environment.scope;
  const matches =
    request.environmentId === scope.environmentId &&
    request.inspection.repositoryIdentity === scope.repositoryIdentity &&
    request.sourceCommit === scope.sourceCommit &&
    request.branch === scope.branch;
  return matches ? allowed(request) : rejected("authorization_mismatch");
};

export interface DecideCommandStartInput {
  readonly authority: ExecutionPolicyAuthority;
  readonly authenticatedWorkspaceId: WorkspaceId;
  readonly request: unknown;
  readonly now: string;
}

export async function decideCommandStart(
  input: DecideCommandStartInput
): Promise<PolicyDecision<StartCommandRequest>> {
  try {
    const request = StartCommandRequestSchema.parse(input.request);
    return await decideStart(input, request);
  } catch {
    return rejected("invalid_input");
  }
}

const decideStart = async (
  input: DecideCommandStartInput,
  request: StartCommandRequest
): Promise<PolicyDecision<StartCommandRequest>> => {
  const records = await resolveCommandStartRecords(input.authority, request);
  if (!records.ok) return records;
  const ownership = validateStartOwnership(input.authenticatedWorkspaceId, request, records.value);
  if (!ownership.ok) return ownership;
  if (!(await sameCommandAuthorization(request.authorization, records.value.command))) {
    return rejected("authorization_mismatch");
  }
  const environment = await validateTrustedEnvironmentAuthorization(
    input.authority,
    records.value.environment,
    records.value.run,
    input.authenticatedWorkspaceId,
    input.now,
    true
  );
  if (!environment.ok) return environment;
  const command = await validateTrustedCommandAuthorization(
    input.authority,
    records.value.command,
    records.value.environment,
    records.value.run,
    input.authenticatedWorkspaceId,
    input.now
  );
  if (!command.ok) return command;
  return validateStartRequest(request, records.value.run, records.value.command);
};

interface CommandStartRecords {
  readonly run: Run;
  readonly environment: EnvironmentAuthorization;
  readonly command: CommandAuthorization;
}

const resolveCommandStartRecords = async (
  authority: ExecutionPolicyAuthority,
  request: StartCommandRequest
): Promise<PolicyDecision<CommandStartRecords>> => {
  const run = await resolveRun(authority, request.runId);
  if (!run.ok) return run;
  const environment = await resolveEnvironmentAuthorization(
    authority,
    request.environmentAuthorizationId
  );
  if (!environment.ok) return environment;
  const command = await resolveCommandAuthorization(authority, request.authorization.id);
  if (!command.ok) return command;
  return allowed({ run: run.value, environment: environment.value, command: command.value });
};

const validateStartOwnership = (
  workspaceId: WorkspaceId,
  request: StartCommandRequest,
  records: CommandStartRecords
): PolicyDecision<void> => {
  if (workspaceId !== records.run.workspaceId || request.workspaceId !== records.run.workspaceId) {
    return rejected("workspace_mismatch");
  }
  if (request.runId !== records.run.id) return rejected("run_mismatch");
  if (request.environmentId !== records.environment.scope.environmentId) {
    return rejected("environment_mismatch");
  }
  if (request.commandId !== records.command.scope.commandId) return rejected("command_mismatch");
  return allowed(undefined);
};

const validateStartRequest = async (
  request: StartCommandRequest,
  run: Run,
  command: CommandAuthorization
): Promise<PolicyDecision<StartCommandRequest>> => {
  const validState =
    (command.scope.action === "implement" && run.status === "implementing") ||
    (command.scope.action === "verify" && run.status === "verifying");
  if (!validState) return rejected("run_state_mismatch");
  const scoped = commandScopeAllows(command.scope, request.command);
  if (!scoped.ok) return scoped;
  return command.scope.commandDigest === (await digestCommandSpec(request.command))
    ? allowed(request)
    : rejected("command_scope_mismatch");
};
