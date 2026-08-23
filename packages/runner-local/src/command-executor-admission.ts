import { types as utilTypes } from "node:util";

import {
  CommandAuthorizationSchema,
  CommandIdSchema,
  StartCommandRequestSchema,
  digestCommandAuthorization,
  digestCommandScope,
  digestCommandSpec,
  normalizeSafeJson
} from "@autostack/contracts";
import type {
  CommandId,
  EnvironmentId,
  PreparedEnvironment,
  StartCommandRequest
} from "@autostack/contracts";

import type { ActiveCommandLease } from "./command-activity.js";
import type { GuardianCloseOutcome, GuardianHostSession } from "./command-guardian.js";
import {
  admitIntrinsicPromise,
  captureGuardianMethod,
  observeIntrinsicPromise,
  snapshotSafeJson
} from "./command-guardian-bounds.js";
import { isForbiddenEnvironmentName } from "./command-environment-policy.js";
import { createCommandExecutorError } from "./command-executor-error.js";
import { parseFrame } from "./replay-spool-codec.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const validateCommandExecutorRequest = async (
  input: StartCommandRequest
): Promise<StartCommandRequest> => {
  try {
    const request = StartCommandRequestSchema.parse(
      normalizeSafeJson(snapshotSafeJson(input, 256 * 1_024))
    );
    const authorization = CommandAuthorizationSchema.parse(request.authorization);
    if (
      request.authorization.id !== authorization.id ||
      request.authorization.digest !== authorization.digest ||
      JSON.stringify(request.authorization) !== JSON.stringify(authorization) ||
      authorization.approvalEvidenceDigest !== (await digestCommandScope(authorization.scope)) ||
      authorization.digest !== (await digestCommandAuthorization(authorization)) ||
      authorization.scope.commandDigest !== (await digestCommandSpec(request.command)) ||
      request.command.environment.some((entry) => isForbiddenEnvironmentName(entry.name))
    ) {
      throw new TypeError();
    }
    const root = authorization.scope.cwdRoot;
    const cwd = request.command.cwd;
    if (!(root === "." || cwd === root || cwd.startsWith(`${root}/`))) throw new TypeError();
    if (
      request.command.timeoutSeconds > authorization.scope.resourceLimits.durationSeconds ||
      request.command.environment.some(
        (entry) =>
          entry.kind === "credential_ref" &&
          !authorization.scope.allowedCredentialRefIds.includes(entry.credentialRefId)
      )
    ) {
      throw new TypeError();
    }
    return Object.freeze(request);
  } catch {
    throw createCommandExecutorError("invalid_request");
  }
};

export const samePreparedEnvironment = (
  prepared: Readonly<{
    readonly environment: PreparedEnvironment;
    readonly managedPath: string;
    readonly intentDigest: string;
  }>,
  request: StartCommandRequest
): boolean => {
  const environment = prepared.environment;
  const authorization = environment.authorization;
  const scope = authorization.scope;
  return (
    environment.state === "prepared" &&
    environment.workspaceId === request.workspaceId &&
    environment.runId === request.runId &&
    environment.environmentId === request.environmentId &&
    environment.repositoryIdentity === scope.repositoryIdentity &&
    environment.sourceCommit === scope.sourceCommit &&
    environment.branch === scope.branch &&
    request.environmentAuthorizationId === authorization.id &&
    request.environmentAuthorizationDigest === authorization.digest &&
    SHA256_PATTERN.test(prepared.intentDigest)
  );
};

const ownDataValue = (input: object, name: string): unknown => {
  const descriptor = Reflect.getOwnPropertyDescriptor(input, name);
  if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
    throw new TypeError();
  }
  return descriptor.value;
};

const snapshotObject = (input: unknown): object => {
  if (typeof input !== "object" || input === null || utilTypes.isProxy(input))
    throw new TypeError();
  return input;
};

export const snapshotPreparedEnvironmentResult = (
  input: unknown
): Readonly<{
  readonly environment: PreparedEnvironment;
  readonly managedPath: unknown;
  readonly intentDigest: unknown;
}> => {
  const candidate = snapshotObject(input);
  const keys = Reflect.ownKeys(candidate);
  if (
    keys.length !== 3 ||
    keys.some((key) => typeof key !== "string") ||
    !["environment", "managedPath", "intentDigest"].every((key) => keys.includes(key))
  )
    throw new TypeError();
  return Object.freeze({
    environment: snapshotSafeJson(
      ownDataValue(candidate, "environment"),
      256 * 1_024
    ) as unknown as PreparedEnvironment,
    managedPath: ownDataValue(candidate, "managedPath"),
    intentDigest: ownDataValue(candidate, "intentDigest")
  });
};

export const snapshotActiveCommandLease = (
  input: unknown,
  environmentId: EnvironmentId,
  commandId: CommandId
): ActiveCommandLease => {
  const candidate = snapshotObject(input);
  if (
    ownDataValue(candidate, "environmentId") !== environmentId ||
    ownDataValue(candidate, "commandId") !== commandId
  ) {
    throw new TypeError();
  }
  const close = captureGuardianMethod(candidate, "close")!;
  return Object.freeze({
    environmentId,
    commandId,
    close: close as ActiveCommandLease["close"]
  });
};

/** Captures raw release authority before caller-controlled lease identity is admitted. */
export const captureUnadmittedActiveCommandLease = (
  input: unknown,
  environmentId: EnvironmentId,
  commandId: CommandId
): ActiveCommandLease => {
  const close = captureGuardianMethod(input, "close")!;
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    environmentId,
    commandId,
    close: async () => {
      closePromise ??= (async () => {
        await Reflect.apply(close, undefined, []);
      })();
      return await closePromise;
    }
  });
};

export const closeUnadmittedActiveCommandLease = async (
  input: unknown,
  environmentId: EnvironmentId,
  commandId: CommandId
): Promise<void> => {
  const retained = captureUnadmittedActiveCommandLease(input, environmentId, commandId);
  try {
    snapshotActiveCommandLease(input, environmentId, commandId);
  } catch {
    // Exact identity admission does not replace previously captured raw release authority.
  }
  await retained.close();
};

export const admitGuardianCloseOutcome = (
  input: unknown,
  expectedCommandId?: CommandId
): GuardianCloseOutcome => {
  try {
    const candidate = snapshotObject(input);
    const keys = Reflect.ownKeys(candidate);
    if (
      keys.some((key) => typeof key !== "string") ||
      (keys.length !== 2 && keys.length !== 3) ||
      !keys.includes("commandId") ||
      !keys.includes("releasedLease") ||
      (keys.length === 3 && !keys.includes("terminalFrame"))
    ) {
      throw new TypeError();
    }
    const commandId = CommandIdSchema.parse(ownDataValue(candidate, "commandId"));
    const releasedLease = ownDataValue(candidate, "releasedLease");
    if (releasedLease !== true && releasedLease !== false) throw new TypeError();
    if (expectedCommandId !== undefined && commandId !== expectedCommandId) throw new TypeError();
    if (!keys.includes("terminalFrame")) {
      return Object.freeze({ commandId, releasedLease });
    }
    const terminalFrame = parseFrame(
      snapshotSafeJson(ownDataValue(candidate, "terminalFrame"), 128 * 1_024)
    );
    if (
      terminalFrame.commandId !== commandId ||
      (terminalFrame.event.type !== "command.completed" &&
        terminalFrame.event.type !== "stream.error")
    ) {
      throw new TypeError();
    }
    return Object.freeze({ commandId, terminalFrame, releasedLease });
  } catch {
    throw new TypeError("Guardian close outcome is invalid.");
  }
};

export const snapshotGuardianHostSession = (
  input: unknown,
  expectedCommandId?: CommandId
): GuardianHostSession => {
  const candidate = snapshotObject(input);
  const keys = Reflect.ownKeys(candidate);
  if (
    keys.length !== 4 ||
    keys.some((key) => typeof key !== "string") ||
    !["sessionId", "send", "disconnect", "closed"].every((key) => keys.includes(key))
  )
    throw new TypeError();
  const sessionId = ownDataValue(candidate, "sessionId");
  const closed = ownDataValue(candidate, "closed");
  if (
    typeof sessionId !== "string" ||
    sessionId.length < 1 ||
    sessionId.length > 256 ||
    !utilTypes.isPromise(closed) ||
    utilTypes.isProxy(closed)
  ) {
    throw new TypeError();
  }
  const send = captureGuardianMethod(candidate, "send")!;
  const disconnect = captureGuardianMethod(candidate, "disconnect")!;
  admitIntrinsicPromise(closed);
  const admittedClosed = observeIntrinsicPromise<unknown, GuardianCloseOutcome, never>(
    closed,
    (outcome) => admitGuardianCloseOutcome(outcome, expectedCommandId),
    (error) => {
      throw error;
    }
  );
  void observeIntrinsicPromise(
    admittedClosed,
    () => undefined,
    () => undefined
  );
  return Object.freeze({
    sessionId,
    send: send as GuardianHostSession["send"],
    disconnect: disconnect as GuardianHostSession["disconnect"],
    closed: admittedClosed
  });
};

/** Captures only raw post-launch disconnect authority before full session admission. */
export const captureUnadmittedGuardianHostSession = (input: unknown): GuardianHostSession => {
  const disconnect = captureGuardianMethod(input, "disconnect")!;
  let disconnectPromise: Promise<void> | undefined;
  const closed = new Promise<GuardianCloseOutcome>(() => undefined);
  return Object.freeze({
    sessionId: "retained-unadmitted",
    async send() {
      throw new TypeError("Guardian session is not admitted.");
    },
    disconnect: async () => {
      disconnectPromise ??= (async () => {
        await Reflect.apply(disconnect, undefined, []);
      })();
      return await disconnectPromise;
    },
    closed
  });
};
