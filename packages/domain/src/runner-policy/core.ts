import {
  ApprovalSchema,
  EnvironmentAuthorizationSchema,
  RunSchema,
  TerminalRunEvidenceSchema,
  type CommandAuthorization,
  type CommandScope,
  type CommandSpec,
  type EnvironmentAuthorization,
  type ExecutionScope,
  type Run
} from "@autostack/contracts";

import {
  allowed,
  rejected,
  type DurableTerminalRunEvidence,
  type Immutable,
  type ImmutableCommandAuthorization,
  type ImmutableEnvironmentAuthorization,
  type PolicyDecision
} from "./types.js";

const parseInstant = (value: string, parse: (value: string) => string): number | undefined => {
  try {
    const instant = Date.parse(parse(value));
    return Number.isFinite(instant) ? instant : undefined;
  } catch {
    return undefined;
  }
};

export const approvalInstant = (value: string): number | undefined =>
  parseInstant(value, (candidate) => ApprovalSchema.shape.createdAt.parse(candidate));

export const authorizationInstant = (value: string): number | undefined =>
  parseInstant(value, (candidate) =>
    EnvironmentAuthorizationSchema.shape.createdAt.parse(candidate)
  );

export const authorizationLifetime = (
  authorization: { readonly createdAt: string; readonly expiresAt: string },
  now: string,
  enforceExpiry: boolean
): PolicyDecision<void> => {
  const created = authorizationInstant(authorization.createdAt);
  const current = authorizationInstant(now);
  const expiresAt = authorizationInstant(authorization.expiresAt);
  if (created === undefined || current === undefined || expiresAt === undefined) {
    return rejected("invalid_input");
  }
  if (created > current) return rejected("authorization_mismatch");
  if (enforceExpiry && current >= expiresAt) return rejected("authorization_expired");
  return allowed(undefined);
};

const frozenResourceLimits = (limits: ExecutionScope["resourceLimits"]) =>
  Object.freeze({ ...limits });

const frozenCredentialReferences = <Reference extends string>(
  references: readonly Reference[]
): readonly Reference[] => Object.freeze([...references]);

export const immutableEnvironmentAuthorization = (
  authorization: EnvironmentAuthorization
): ImmutableEnvironmentAuthorization => {
  const scope: Immutable<ExecutionScope> = Object.freeze({
    ...authorization.scope,
    resourceLimits: frozenResourceLimits(authorization.scope.resourceLimits),
    allowedCredentialRefIds: frozenCredentialReferences(authorization.scope.allowedCredentialRefIds)
  });
  return Object.freeze({ ...authorization, scope });
};

export const immutableCommandAuthorization = (
  authorization: CommandAuthorization
): ImmutableCommandAuthorization => {
  const scope: Immutable<CommandScope> = Object.freeze({
    ...authorization.scope,
    resourceLimits: frozenResourceLimits(authorization.scope.resourceLimits),
    allowedCredentialRefIds: frozenCredentialReferences(authorization.scope.allowedCredentialRefIds)
  });
  return Object.freeze({ ...authorization, scope });
};

export const commandScopeAllows = (
  scope: CommandScope,
  command: CommandSpec
): PolicyDecision<void> => {
  const insideRoot =
    scope.cwdRoot === "." ||
    command.cwd === scope.cwdRoot ||
    command.cwd.startsWith(`${scope.cwdRoot}/`);
  if (!insideRoot) return rejected("cwd_outside_scope");
  if (command.timeoutSeconds > scope.resourceLimits.durationSeconds) {
    return rejected("timeout_exceeds_limit");
  }
  const permitsCredentials = command.environment.every(
    (entry) =>
      entry.kind !== "credential_ref" ||
      scope.allowedCredentialRefIds.includes(entry.credentialRefId)
  );
  return permitsCredentials ? allowed(undefined) : rejected("credential_not_allowed");
};

export const terminalEvidence = (candidate: unknown): DurableTerminalRunEvidence => {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new TypeError("A durable terminal record is required.");
  }
  const record = Object.fromEntries(Object.entries(candidate));
  return {
    workspaceId: RunSchema.shape.workspaceId.parse(record.workspaceId),
    runId: RunSchema.shape.id.parse(record.runId),
    evidence: TerminalRunEvidenceSchema.parse(record.evidence)
  };
};
