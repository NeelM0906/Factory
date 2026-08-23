import { types as utilTypes } from "node:util";

import {
  PrepareEnvironmentRequestSchema,
  ReadArtifactChunkRequestSchema,
  StartCommandRequestSchema,
  digestCommandAuthorization,
  digestCommandScope,
  digestCommandSpec,
  digestEnvironmentAuthorization,
  digestExecutionScope,
  normalizeSafeJson,
  type PrepareEnvironmentRequest,
  type ReadArtifactChunkRequest,
  type StartCommandRequest
} from "@autostack/contracts";

import { CommandExecutorError, type CommandExecutorErrorCode } from "./command-executor-error.js";
import type {
  CommandExecutionLimits,
  CommandExecutorOptions,
  CommandSecretResolver,
  ExecutableResolver,
  GuardianLauncher,
  GuardianSessionMaterial
} from "./command-executor-types.js";
import { GitClientError } from "./git-client.js";
import {
  LocalRunnerProviderError,
  type LocalRunnerProviderErrorCode
} from "./local-runner-provider-error.js";
import { WorktreeManagerError, type TerminalEvidenceVerification } from "./worktree-manager.js";

export interface LocalRunnerProviderOptions {
  readonly dataRoot: string;
  readonly guardianLauncher: GuardianLauncher;
  readonly resolveCredentials: CommandSecretResolver;
  readonly executableResolver: ExecutableResolver;
  readonly trustedBaseEnvironment: CommandExecutorOptions["trustedBaseEnvironment"];
  readonly limits: CommandExecutionLimits;
  readonly now: () => string;
  readonly monotonicNowMs: () => number;
  readonly createArtifactId: CommandExecutorOptions["createArtifactId"];
  readonly createGuardianSession: () => GuardianSessionMaterial;
  readonly verifyTerminalEvidence: (
    verification: TerminalEvidenceVerification
  ) => Promise<boolean> | boolean;
  readonly trustedGitExecutable?: string;
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
};

const snapshotValue = (value: unknown): unknown => {
  let count = 0;
  const visit = (candidate: unknown, depth: number): unknown => {
    count += 1;
    if (count > 20_000 || depth > 32) throw new TypeError();
    if (candidate === null || typeof candidate !== "object") return candidate;
    if (utilTypes.isProxy(candidate)) throw new TypeError();
    if (Array.isArray(candidate)) {
      if (candidate.length > 10_000) throw new TypeError();
      return candidate.map((item) => visit(item, depth + 1));
    }
    const keys = Reflect.ownKeys(candidate);
    if (keys.length > 256) throw new TypeError();
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string") throw new TypeError();
      const descriptor = Reflect.getOwnPropertyDescriptor(candidate, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError();
      }
      result[key] = visit(descriptor.value, depth + 1);
    }
    return result;
  };
  const result = visit(value, 0);
  if (JSON.stringify(result).length > 2 * 1_048_576) throw new TypeError();
  return result;
};

const requestedNetworkPolicy = (snapshot: unknown): unknown => {
  if (typeof snapshot !== "object" || snapshot === null) return undefined;
  const authorization = (snapshot as Record<string, unknown>).authorization;
  if (typeof authorization !== "object" || authorization === null) return undefined;
  const scope = (authorization as Record<string, unknown>).scope;
  return typeof scope === "object" && scope !== null
    ? (scope as Record<string, unknown>).networkPolicy
    : undefined;
};

export const parsePrepareRequest = async (
  input: PrepareEnvironmentRequest
): Promise<PrepareEnvironmentRequest> => {
  let snapshot: unknown;
  try {
    snapshot = snapshotValue(input);
  } catch {
    throw new LocalRunnerProviderError("invalid_request");
  }
  const policy = requestedNetworkPolicy(snapshot);
  if (policy === "none" || policy === "restricted") {
    throw new LocalRunnerProviderError("unsupported_policy");
  }
  let request: PrepareEnvironmentRequest;
  try {
    request = PrepareEnvironmentRequestSchema.parse(normalizeSafeJson(snapshot));
  } catch {
    throw new LocalRunnerProviderError("invalid_request");
  }
  const scope = request.authorization.scope;
  if (
    request.workspaceId !== scope.workspaceId ||
    request.runId !== scope.runId ||
    request.environmentId !== scope.environmentId ||
    request.inspection.repositoryIdentity !== scope.repositoryIdentity ||
    request.sourceCommit !== scope.sourceCommit ||
    request.branch !== scope.branch ||
    request.sourceCommit !== request.inspection.sourceCommit ||
    request.authorization.digest !==
      (await digestEnvironmentAuthorization(request.authorization)) ||
    request.authorization.approvalEvidenceDigest !== (await digestExecutionScope(scope))
  ) {
    throw new LocalRunnerProviderError("authorization_mismatch");
  }
  return request;
};

export const parseStartRequest = async (
  input: StartCommandRequest
): Promise<StartCommandRequest> => {
  let snapshot: unknown;
  try {
    snapshot = snapshotValue(input);
  } catch {
    throw new LocalRunnerProviderError("invalid_request");
  }
  const policy = requestedNetworkPolicy(snapshot);
  if (policy === "none" || policy === "restricted") {
    throw new LocalRunnerProviderError("unsupported_policy");
  }
  let request: StartCommandRequest;
  try {
    request = StartCommandRequestSchema.parse(normalizeSafeJson(snapshot));
  } catch {
    throw new LocalRunnerProviderError("invalid_request");
  }
  const scope = request.authorization.scope;
  if (
    scope.workspaceId !== request.workspaceId ||
    scope.runId !== request.runId ||
    scope.environmentId !== request.environmentId ||
    scope.commandId !== request.commandId ||
    scope.environmentAuthorizationId !== request.environmentAuthorizationId ||
    scope.environmentAuthorizationDigest !== request.environmentAuthorizationDigest ||
    scope.commandDigest !== (await digestCommandSpec(request.command)) ||
    request.authorization.approvalEvidenceDigest !== (await digestCommandScope(scope)) ||
    request.authorization.digest !== (await digestCommandAuthorization(request.authorization))
  ) {
    throw new LocalRunnerProviderError("authorization_mismatch");
  }
  return request;
};

export const parseArtifactRequest = (input: ReadArtifactChunkRequest): ReadArtifactChunkRequest => {
  try {
    return ReadArtifactChunkRequestSchema.parse(normalizeSafeJson(snapshotValue(input)));
  } catch {
    throw new LocalRunnerProviderError("invalid_request");
  }
};

export const assertAuthorizationCurrent = (
  authorization: Readonly<{ createdAt: string; expiresAt: string }>,
  now: string
): void => {
  const nowMs = Date.parse(now);
  if (
    !Number.isFinite(nowMs) ||
    nowMs < Date.parse(authorization.createdAt) ||
    nowMs >= Date.parse(authorization.expiresAt)
  ) {
    throw new LocalRunnerProviderError("authorization_stale");
  }
};

const mapWorktreeError = (error: WorktreeManagerError): LocalRunnerProviderError => {
  const code: LocalRunnerProviderErrorCode =
    error.code === "root_busy"
      ? "root_busy"
      : error.code === "closed"
        ? "closed"
        : error.code === "active_commands"
          ? "active_command"
          : error.code === "terminal_evidence_invalid"
            ? "terminal_evidence_invalid"
            : error.code === "dirty_worktree"
              ? "dirty_worktree"
              : error.code === "maintenance_required"
                ? "maintenance_required"
                : error.code === "environment_conflict"
                  ? "conflict"
                  : error.code === "invalid_request"
                    ? "invalid_request"
                    : "unsafe_state";
  return new LocalRunnerProviderError(code);
};

const mapExecutorCode = (code: CommandExecutorErrorCode): LocalRunnerProviderErrorCode =>
  code === "closed"
    ? "closed"
    : code === "command_conflict" || code === "environment_conflict"
      ? "conflict"
      : code === "maintenance_required"
        ? "maintenance_required"
        : code === "missing_credential"
          ? "missing_credential"
          : code === "authorization_stale"
            ? "authorization_stale"
            : code === "active_command"
              ? "active_command"
              : code === "command_not_found"
                ? "command_not_found"
                : code === "execution_unavailable"
                  ? "unsafe_state"
                  : code === "invalid_request"
                    ? "invalid_request"
                    : "unsafe_state";

export const rematerializeProviderError = (error: unknown): LocalRunnerProviderError => {
  if (error instanceof LocalRunnerProviderError) return new LocalRunnerProviderError(error.code);
  if (error instanceof WorktreeManagerError) return mapWorktreeError(error);
  if (error instanceof CommandExecutorError) {
    return new LocalRunnerProviderError(mapExecutorCode(error.code));
  }
  if (error instanceof GitClientError) {
    return new LocalRunnerProviderError(
      error.code === "invalid_request" ? "invalid_request" : "invalid_path"
    );
  }
  return new LocalRunnerProviderError("unsafe_state");
};

const ownDataRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value))
    throw new TypeError();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError();
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError();
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
};

const captureMethod = <T extends (...args: never[]) => unknown>(
  receiver: unknown,
  name: string
): T => {
  if (typeof receiver !== "object" || receiver === null || utilTypes.isProxy(receiver)) {
    throw new TypeError();
  }
  let current: object | null = receiver;
  while (current !== null) {
    if (utilTypes.isProxy(current)) throw new TypeError();
    const descriptor = Reflect.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") throw new TypeError();
      const method = descriptor.value as T;
      return ((...args: never[]) => Reflect.apply(method, receiver, args)) as T;
    }
    current = Reflect.getPrototypeOf(current);
  }
  throw new TypeError();
};

export const snapshotProviderOptions = (
  input: LocalRunnerProviderOptions
): LocalRunnerProviderOptions => {
  try {
    const allowed = [
      "dataRoot",
      "guardianLauncher",
      "resolveCredentials",
      "executableResolver",
      "trustedBaseEnvironment",
      "limits",
      "now",
      "monotonicNowMs",
      "createArtifactId",
      "createGuardianSession",
      "verifyTerminalEvidence",
      "trustedGitExecutable"
    ];
    const snapshot = ownDataRecord(input);
    if (Object.keys(snapshot).some((key) => !allowed.includes(key))) throw new TypeError();
    if (typeof snapshot.dataRoot !== "string" || !snapshot.dataRoot.startsWith("/")) {
      throw new TypeError();
    }
    for (const name of [
      "resolveCredentials",
      "now",
      "monotonicNowMs",
      "createArtifactId",
      "createGuardianSession",
      "verifyTerminalEvidence"
    ]) {
      if (typeof snapshot[name] !== "function") throw new TypeError();
    }
    const limits = deepFreeze(snapshotValue(snapshot.limits) as CommandExecutionLimits);
    const trustedBaseEnvironment = deepFreeze(
      snapshotValue(
        snapshot.trustedBaseEnvironment
      ) as CommandExecutorOptions["trustedBaseEnvironment"]
    );
    const resolveCredentials = snapshot.resolveCredentials as CommandSecretResolver;
    const now = snapshot.now as () => string;
    const monotonicNowMs = snapshot.monotonicNowMs as () => number;
    const createArtifactId =
      snapshot.createArtifactId as CommandExecutorOptions["createArtifactId"];
    const createGuardianSession = snapshot.createGuardianSession as () => GuardianSessionMaterial;
    const verifyTerminalEvidence =
      snapshot.verifyTerminalEvidence as LocalRunnerProviderOptions["verifyTerminalEvidence"];
    const launch = captureMethod<GuardianLauncher["launch"]>(snapshot.guardianLauncher, "launch");
    const resolve = captureMethod<ExecutableResolver["resolve"]>(
      snapshot.executableResolver,
      "resolve"
    );
    if (
      snapshot.trustedGitExecutable !== undefined &&
      typeof snapshot.trustedGitExecutable !== "string"
    ) {
      throw new TypeError();
    }
    return Object.freeze({
      dataRoot: snapshot.dataRoot,
      guardianLauncher: Object.freeze({ launch }),
      resolveCredentials: (request: Parameters<CommandSecretResolver>[0]) =>
        Reflect.apply(resolveCredentials, undefined, [request]),
      executableResolver: Object.freeze({ resolve }),
      trustedBaseEnvironment,
      limits,
      now: () => Reflect.apply(now, undefined, []),
      monotonicNowMs: () => Reflect.apply(monotonicNowMs, undefined, []),
      createArtifactId: () => Reflect.apply(createArtifactId, undefined, []),
      createGuardianSession: () => Reflect.apply(createGuardianSession, undefined, []),
      verifyTerminalEvidence: (verification: TerminalEvidenceVerification) =>
        Reflect.apply(verifyTerminalEvidence, undefined, [verification]),
      ...(snapshot.trustedGitExecutable === undefined
        ? {}
        : { trustedGitExecutable: snapshot.trustedGitExecutable })
    });
  } catch {
    throw new LocalRunnerProviderError("invalid_request");
  }
};
