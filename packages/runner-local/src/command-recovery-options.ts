import { types as utilTypes } from "node:util";

import type { CommandId } from "@autostack/contracts";

import type { ArtifactStore } from "./artifact-store.js";
import type { CommandGuardianLease } from "./data-root-lock.js";
import type { ReplaySpool } from "./replay-spool.js";

const snapshotExactDataRecord = (
  candidate: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Readonly<Record<string, unknown>> => {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    utilTypes.isProxy(candidate)
  ) {
    throw new TypeError();
  }
  const keys = Reflect.ownKeys(candidate);
  if (
    keys.some(
      (key) => typeof key !== "string" || (!required.includes(key) && !optional.includes(key))
    ) ||
    required.some((key) => !keys.includes(key))
  ) {
    throw new TypeError();
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(candidate, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError();
    }
    result[key as string] = descriptor.value;
  }
  return Object.freeze(result);
};

export interface AdmittedRecoveryOpenOptions {
  readonly dataRoot: string;
  readonly commandId: CommandId;
  readonly lease: CommandGuardianLease;
  readonly createAttemptId?: () => string;
}

export const snapshotRecoveryOpenOptions = (candidate: unknown): AdmittedRecoveryOpenOptions => {
  const options = snapshotExactDataRecord(
    candidate,
    ["dataRoot", "commandId", "lease"],
    ["createAttemptId"]
  );
  const createAttemptId = options.createAttemptId;
  if (createAttemptId !== undefined && typeof createAttemptId !== "function") throw new TypeError();
  return Object.freeze({
    dataRoot: options.dataRoot as string,
    commandId: options.commandId as CommandId,
    lease: options.lease as CommandGuardianLease,
    ...(createAttemptId === undefined ? {} : { createAttemptId: createAttemptId as () => string })
  });
};

export interface AdmittedRecoverCommandOptions {
  readonly dataRoot: string;
  readonly commandId: CommandId;
  readonly spool: ReplaySpool;
  readonly artifactStore: ArtifactStore;
  readonly acquiredLease: CommandGuardianLease;
}

export const snapshotRecoverCommandOptions = (
  candidate: unknown
): AdmittedRecoverCommandOptions => {
  const options = snapshotExactDataRecord(candidate, [
    "dataRoot",
    "commandId",
    "spool",
    "artifactStore",
    "acquiredLease"
  ]);
  return Object.freeze({
    dataRoot: options.dataRoot as string,
    commandId: options.commandId as CommandId,
    spool: options.spool as ReplaySpool,
    artifactStore: options.artifactStore as ArtifactStore,
    acquiredLease: options.acquiredLease as CommandGuardianLease
  });
};
