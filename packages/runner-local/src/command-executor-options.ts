import { isAbsolute } from "node:path";
import { types as utilTypes } from "node:util";

import { snapshotArtifactStoreCapability } from "./artifact-mutation-authority.js";
import {
  createCommandExecutorError,
  admitPositiveBoundedInteger
} from "./command-executor-error.js";
import type { CommandExecutionLimits, CommandExecutorOptions } from "./command-executor-types.js";
import { snapshotTrustedBaseEnvironment } from "./command-runtime-preparation.js";
import type { PtyEnvironmentValue } from "./pty.js";

export interface AdmittedCommandExecutorOptions extends CommandExecutorOptions {
  readonly trustedBaseEnvironment: readonly PtyEnvironmentValue[];
  readonly limits: CommandExecutionLimits;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !utilTypes.isProxy(value);

const snapshotOwnDataRecord = (
  value: unknown,
  maximumKeys = 32
): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) throw new TypeError();
  const keys = Reflect.ownKeys(value);
  if (keys.length > maximumKeys) throw new TypeError();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") throw new TypeError();
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError();
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
};

const captureMethod = (value: unknown, name: string): ((...args: never[]) => unknown) => {
  if (!isRecord(value)) throw new TypeError();
  let current: object | null = value;
  while (current !== null) {
    if (utilTypes.isProxy(current)) throw new TypeError();
    const descriptor = Reflect.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") throw new TypeError();
      const method = descriptor.value as (...args: never[]) => unknown;
      return (...args: never[]) => Reflect.apply(method, value, args);
    }
    current = Reflect.getPrototypeOf(current);
  }
  throw new TypeError();
};

export const snapshotCommandExecutorOptions = (
  input: CommandExecutorOptions
): AdmittedCommandExecutorOptions => {
  try {
    const options = snapshotOwnDataRecord(input);
    const dataRoot = options.dataRoot;
    if (typeof dataRoot !== "string" || !isAbsolute(dataRoot)) throw new TypeError();
    const worktreeResolve = captureMethod(options.worktrees, "resolvePreparedEnvironment");
    const reserveCommand = captureMethod(options.activity, "reserveCommand");
    const acquireEnvironmentQuiescence = captureMethod(
      options.activity,
      "acquireEnvironmentQuiescence"
    );
    const closeAdmission = captureMethod(options.activity, "closeAdmission");
    const launchGuardian = captureMethod(options.guardianLauncher, "launch");
    const resolveCredentials = captureMethod(options, "resolveCredentials");
    const resolveExecutable = captureMethod(options.executableResolver, "resolve");
    const now = captureMethod(options, "now");
    const monotonicNowMs = captureMethod(options, "monotonicNowMs");
    const createArtifactId = captureMethod(options, "createArtifactId");
    const createGuardianSession = captureMethod(options, "createGuardianSession");
    if (utilTypes.isProxy(options.artifactStore)) {
      throw new TypeError();
    }
    const artifactStore = snapshotArtifactStoreCapability(options.artifactStore);
    const environment = snapshotTrustedBaseEnvironment(
      dataRoot,
      options.trustedBaseEnvironment as never
    );
    const limitInput = snapshotOwnDataRecord(options.limits);
    const limits = Object.freeze({
      eventBytes: admitPositiveBoundedInteger(limitInput.eventBytes, 128 * 1_024),
      replayBytes: admitPositiveBoundedInteger(limitInput.replayBytes, 64 * 1_048_576),
      transcriptBytes: admitPositiveBoundedInteger(limitInput.transcriptBytes, 64 * 1_048_576),
      artifactBytes: admitPositiveBoundedInteger(limitInput.artifactBytes, 64 * 1_048_576),
      cancellationGraceMs: admitPositiveBoundedInteger(limitInput.cancellationGraceMs, 60_000),
      eofSettleMs: admitPositiveBoundedInteger(limitInput.eofSettleMs, 60_000),
      subscriberQueueFrames: admitPositiveBoundedInteger(limitInput.subscriberQueueFrames, 10_000),
      subscriberQueueBytes: admitPositiveBoundedInteger(
        limitInput.subscriberQueueBytes,
        64 * 1_048_576
      )
    });
    if (
      limits.eventBytes < 8_192 ||
      limits.replayBytes < 32_768 ||
      limits.replayBytes < limits.eventBytes * 4
    ) {
      throw new TypeError();
    }
    return Object.freeze({
      dataRoot,
      worktrees: Object.freeze({ resolvePreparedEnvironment: worktreeResolve as never }),
      artifactStore,
      activity: Object.freeze({
        reserveCommand: reserveCommand as never,
        acquireEnvironmentQuiescence: acquireEnvironmentQuiescence as never,
        closeAdmission: closeAdmission as never
      }),
      guardianLauncher: Object.freeze({ launch: launchGuardian as never }),
      resolveCredentials: resolveCredentials as never,
      executableResolver: Object.freeze({ resolve: resolveExecutable as never }),
      trustedBaseEnvironment: Object.freeze(environment),
      limits,
      now: now as never,
      monotonicNowMs: monotonicNowMs as never,
      createArtifactId: createArtifactId as never,
      createGuardianSession: createGuardianSession as never
    });
  } catch {
    throw createCommandExecutorError("invalid_request");
  }
};
