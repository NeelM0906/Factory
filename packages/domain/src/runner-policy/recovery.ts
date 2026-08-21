import {
  ActorSchema,
  ArtifactDescriptorSchema,
  CancelCommandRequestSchema,
  DisposeEnvironmentRequestSchema,
  ReadArtifactChunkRequestSchema,
  ReadCommandEventsRequestSchema,
  RunSchema,
  validateCommandAuthorizationAgainstEnvironment,
  type ArtifactDescriptor,
  type CancelCommandRequest,
  type CommandAuthorization,
  type DisposeEnvironmentRequest,
  type EnvironmentAuthorization,
  type ReadArtifactChunkRequest,
  type ReadCommandEventsRequest,
  type Run,
  type WorkspaceId
} from "@autostack/contracts";

import {
  resolveById,
  resolveCommandAuthorization,
  resolveEnvironmentAuthorization,
  resolveRun,
  sameCommandAuthorization,
  sameEnvironmentAuthorization
} from "./authority.js";
import { terminalEvidence } from "./core.js";
import {
  allowed,
  rejected,
  type DurableTerminalRunEvidence,
  type ExecutionPolicyAuthority,
  type PolicyDecision
} from "./types.js";

type OwnedRequest = ReadCommandEventsRequest | CancelCommandRequest | ReadArtifactChunkRequest;

interface OwnedRecords<Request extends OwnedRequest> {
  readonly request: Request;
  readonly run: Run;
  readonly environment: EnvironmentAuthorization;
  readonly command: CommandAuthorization;
}

const authorizeOwnedCommand = async <Request extends OwnedRequest>(
  authority: ExecutionPolicyAuthority,
  authenticatedWorkspaceId: WorkspaceId,
  request: Request
): Promise<PolicyDecision<OwnedRecords<Request>>> => {
  const records = await resolveOwnedRecords(authority, request);
  if (!records.ok) return records;
  const ownership = validateOwnedIdentity(authenticatedWorkspaceId, request, records.value);
  if (!ownership.ok) return ownership;
  return (await validateOwnedAuthorizations(request, records.value))
    ? allowed({ request, ...records.value })
    : rejected("authorization_mismatch");
};

const resolveOwnedRecords = async <Request extends OwnedRequest>(
  authority: ExecutionPolicyAuthority,
  request: Request
): Promise<PolicyDecision<Omit<OwnedRecords<Request>, "request">>> => {
  const run = await resolveRun(authority, request.runId);
  if (!run.ok) return run;
  const environment = await resolveEnvironmentAuthorization(
    authority,
    request.environmentAuthorizationId
  );
  if (!environment.ok) return environment;
  const command = await resolveCommandAuthorization(authority, request.commandAuthorizationId);
  if (!command.ok) return command;
  return allowed({ run: run.value, environment: environment.value, command: command.value });
};

const validateOwnedIdentity = <Request extends OwnedRequest>(
  workspaceId: WorkspaceId,
  request: Request,
  records: Omit<OwnedRecords<Request>, "request">
): PolicyDecision<void> => {
  if (workspaceId !== records.run.workspaceId || request.workspaceId !== records.run.workspaceId) {
    return rejected("workspace_mismatch");
  }
  if (
    request.runId !== records.run.id ||
    records.environment.scope.runId !== records.run.id ||
    records.command.scope.runId !== records.run.id
  ) {
    return rejected("run_mismatch");
  }
  if (
    request.environmentId !== records.environment.scope.environmentId ||
    records.command.scope.environmentId !== request.environmentId
  ) {
    return rejected("environment_mismatch");
  }
  return request.commandId === records.command.scope.commandId
    ? allowed(undefined)
    : rejected("command_mismatch");
};

const validateOwnedAuthorizations = async <Request extends OwnedRequest>(
  request: Request,
  records: Omit<OwnedRecords<Request>, "request">
): Promise<boolean> => {
  if (
    request.environmentAuthorizationDigest !== records.environment.digest ||
    request.commandAuthorizationDigest !== records.command.digest
  ) {
    return false;
  }
  if (!(await sameEnvironmentAuthorization(records.environment, records.environment))) return false;
  if (!(await sameCommandAuthorization(records.command, records.command))) return false;
  try {
    validateCommandAuthorizationAgainstEnvironment(records.command, records.environment);
    return true;
  } catch {
    return false;
  }
};

export async function authorizeCommandEvents(input: {
  readonly authority: ExecutionPolicyAuthority;
  readonly authenticatedWorkspaceId: WorkspaceId;
  readonly request?: unknown;
}): Promise<PolicyDecision<ReadCommandEventsRequest>> {
  try {
    if (input.request === undefined) return rejected("invalid_input");
    const request = ReadCommandEventsRequestSchema.parse(input.request);
    const owned = await authorizeOwnedCommand(
      input.authority,
      input.authenticatedWorkspaceId,
      request
    );
    return owned.ok ? allowed(owned.value.request) : owned;
  } catch {
    return rejected("invalid_input");
  }
}

export async function authorizeCancelCommand(input: {
  readonly authority: ExecutionPolicyAuthority;
  readonly authenticatedWorkspaceId: WorkspaceId;
  readonly request?: unknown;
}): Promise<PolicyDecision<CancelCommandRequest>> {
  try {
    if (input.request === undefined) return rejected("invalid_input");
    const request = CancelCommandRequestSchema.parse(input.request);
    const owned = await authorizeOwnedCommand(
      input.authority,
      input.authenticatedWorkspaceId,
      request
    );
    return owned.ok ? allowed(owned.value.request) : owned;
  } catch {
    return rejected("invalid_input");
  }
}

export async function authorizeArtifactRead(input: {
  readonly authority: ExecutionPolicyAuthority;
  readonly authenticatedWorkspaceId: WorkspaceId;
  readonly request?: unknown;
}): Promise<PolicyDecision<ReadArtifactChunkRequest>> {
  try {
    if (input.request === undefined) return rejected("invalid_input");
    const request = ReadArtifactChunkRequestSchema.parse(input.request);
    const owned = await authorizeOwnedCommand(
      input.authority,
      input.authenticatedWorkspaceId,
      request
    );
    if (!owned.ok) return owned;
    return await validateOwnedArtifact(input.authority, request);
  } catch {
    return rejected("invalid_input");
  }
}

const validateOwnedArtifact = async (
  authority: ExecutionPolicyAuthority,
  request: ReadArtifactChunkRequest
): Promise<PolicyDecision<ReadArtifactChunkRequest>> => {
  const artifact = await resolveById(
    request.artifactId,
    () => authority.resolveArtifact(request.artifactId),
    ArtifactDescriptorSchema.parse,
    (record) => record.artifactId
  );
  if (!artifact.ok) return artifact;
  return artifactMatchesRequest(artifact.value, request)
    ? allowed(request)
    : rejected("artifact_mismatch");
};

const artifactMatchesRequest = (
  artifact: ArtifactDescriptor,
  request: ReadArtifactChunkRequest
): boolean =>
  artifact.workspaceId === request.workspaceId &&
  artifact.runId === request.runId &&
  artifact.commandId === request.commandId &&
  artifact.artifactId === request.artifactId;

export async function decideEnvironmentDisposal(input: {
  readonly authority: ExecutionPolicyAuthority;
  readonly authenticatedWorkspaceId: WorkspaceId;
  readonly request?: unknown;
  readonly actor?: unknown;
  readonly origin?: unknown;
}): Promise<PolicyDecision<DisposeEnvironmentRequest>> {
  try {
    if (input.request === undefined) return rejected("invalid_input");
    const request = DisposeEnvironmentRequestSchema.parse(input.request);
    if (!isOperator(input.actor, input.origin)) return rejected("operator_required");
    return await decideDisposal(input.authority, input.authenticatedWorkspaceId, request);
  } catch {
    return rejected("invalid_input");
  }
}

const isOperator = (actor: unknown, origin: unknown): boolean => {
  const parsedActor = ActorSchema.safeParse(actor);
  return (
    parsedActor.success &&
    parsedActor.data.kind === "user" &&
    (origin === "desktop" || origin === "api" || origin === "cli")
  );
};

const decideDisposal = async (
  authority: ExecutionPolicyAuthority,
  authenticatedWorkspaceId: WorkspaceId,
  request: DisposeEnvironmentRequest
): Promise<PolicyDecision<DisposeEnvironmentRequest>> => {
  const records = await resolveDisposalRecords(authority, request);
  if (!records.ok) return records;
  const ownership = await validateDisposalOwnership(
    authority,
    authenticatedWorkspaceId,
    request,
    records.value
  );
  if (!ownership.ok) return ownership;
  return durableEvidenceMatches(records.value.run, request, records.value.durable)
    ? allowed(request)
    : rejected("terminal_evidence_mismatch");
};

interface DisposalRecords {
  readonly run: Run;
  readonly environment: EnvironmentAuthorization;
  readonly durable: DurableTerminalRunEvidence;
}

const resolveDisposalRecords = async (
  authority: ExecutionPolicyAuthority,
  request: DisposeEnvironmentRequest
): Promise<PolicyDecision<DisposalRecords>> => {
  const run = await resolveRun(authority, request.runId);
  if (!run.ok) return run;
  const environment = await resolveEnvironmentAuthorization(
    authority,
    request.environmentAuthorizationId
  );
  if (!environment.ok) return environment;
  const durable = await resolveById(
    request.runId,
    () => authority.resolveTerminalRunEvidence(request.runId),
    terminalEvidence,
    (record) => record.runId
  );
  if (!durable.ok) return durable;
  return allowed({ run: run.value, environment: environment.value, durable: durable.value });
};

const validateDisposalOwnership = async (
  authority: ExecutionPolicyAuthority,
  workspaceId: WorkspaceId,
  request: DisposeEnvironmentRequest,
  records: DisposalRecords
): Promise<PolicyDecision<void>> => {
  if (workspaceId !== records.run.workspaceId || request.workspaceId !== records.run.workspaceId) {
    return rejected("workspace_mismatch");
  }
  if (records.environment.scope.workspaceId !== records.run.workspaceId) {
    return rejected("workspace_mismatch");
  }
  if (request.runId !== records.run.id || records.environment.scope.runId !== records.run.id) {
    return rejected("run_mismatch");
  }
  if (request.environmentId !== records.environment.scope.environmentId) {
    return rejected("environment_mismatch");
  }
  if (
    request.environmentAuthorizationDigest !== records.environment.digest ||
    !(await sameEnvironmentAuthorization(records.environment, records.environment))
  ) {
    return rejected("authorization_mismatch");
  }
  const active = await authority.hasActiveCommands({
    workspaceId: request.workspaceId,
    runId: request.runId,
    environmentId: request.environmentId
  });
  return active ? rejected("active_command") : allowed(undefined);
};

const durableEvidenceMatches = (
  run: Run,
  request: DisposeEnvironmentRequest,
  durable: DurableTerminalRunEvidence
): boolean =>
  durable.workspaceId === request.workspaceId &&
  durable.runId === request.runId &&
  run.status === durable.evidence.status &&
  run.status === request.terminalRunEvidence.status &&
  durable.evidence.terminalEventSequence === request.terminalRunEvidence.terminalEventSequence &&
  durable.evidence.terminalEventDigest === request.terminalRunEvidence.terminalEventDigest;
