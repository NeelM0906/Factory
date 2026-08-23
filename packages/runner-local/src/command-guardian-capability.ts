import { types as utilTypes } from "node:util";

import { captureGuardianMethod, snapshotDataRecord } from "./command-guardian-bounds.js";
import { DARWIN_TERMINATING_SIGNALS, isDarwinTerminatingSignal } from "./darwin-process-signals.js";
import type {
  BoundProcessTreeAuthority,
  BoundPtySpawnResult,
  Disposable,
  ProcessTreeExitProof,
  PtySession
} from "./pty.js";

export { DARWIN_TERMINATING_SIGNALS, isDarwinTerminatingSignal };

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

const exactKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): boolean => {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
};

const snapshotIdentityDigest = (authority: unknown): string => {
  if (typeof authority !== "object" || authority === null || utilTypes.isProxy(authority)) {
    throw new TypeError();
  }
  const descriptor = Reflect.getOwnPropertyDescriptor(authority, "identityDigest");
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string" ||
    !DIGEST_PATTERN.test(descriptor.value)
  ) {
    throw new TypeError();
  }
  return descriptor.value;
};

const snapshotProcessTree = (input: unknown): BoundProcessTreeAuthority => {
  const identityDigest = snapshotIdentityDigest(input);
  const signal = captureGuardianMethod(input, "signal")!;
  const waitForExit = captureGuardianMethod(input, "waitForExit")!;
  return Object.freeze({
    identityDigest,
    signal: signal as BoundProcessTreeAuthority["signal"],
    waitForExit: waitForExit as BoundProcessTreeAuthority["waitForExit"]
  });
};

const snapshotSession = (input: unknown): PtySession => {
  const write = captureGuardianMethod(input, "write")!;
  const resize = captureGuardianMethod(input, "resize")!;
  return Object.freeze({
    write: write as PtySession["write"],
    resize: resize as PtySession["resize"]
  });
};

const snapshotDisposable = (input: unknown): Disposable => {
  const dispose = captureGuardianMethod(input, "dispose")!;
  return Object.freeze({ dispose: dispose as Disposable["dispose"] });
};

/** Snapshots the synchronous native result exactly once before any await or control dispatch. */
export const admitBoundPtySpawnResult = (input: unknown): BoundPtySpawnResult => {
  let retainedProcessTree: BoundProcessTreeAuthority | undefined;
  if (typeof input === "object" && input !== null && !utilTypes.isProxy(input)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(input, "processTree");
    if (descriptor !== undefined && "value" in descriptor) {
      try {
        retainedProcessTree = snapshotProcessTree(descriptor.value);
      } catch {
        // Full admission below supplies the static failure when no authority can be retained.
      }
    }
  }
  let result: Readonly<Record<string, unknown>>;
  try {
    result = snapshotDataRecord(input, 8);
  } catch (error) {
    if (retainedProcessTree !== undefined) {
      return Object.freeze({ status: "uncertain", processTree: retainedProcessTree });
    }
    throw error;
  }
  if (result.status === "rejected" && exactKeys(result, ["status"])) {
    return Object.freeze({ status: "rejected" });
  }
  if (Object.hasOwn(result, "processTree")) {
    const processTree = retainedProcessTree ?? snapshotProcessTree(result.processTree);
    if (result.status === "uncertain" && exactKeys(result, ["status", "processTree"])) {
      return Object.freeze({ status: "uncertain", processTree });
    }
    if (
      result.status === "spawned" &&
      exactKeys(result, ["status", "session", "processTree", "capture"])
    ) {
      try {
        return Object.freeze({
          status: "spawned",
          session: snapshotSession(result.session),
          processTree,
          capture: snapshotDisposable(result.capture)
        });
      } catch {
        return Object.freeze({ status: "uncertain", processTree });
      }
    }
    return Object.freeze({ status: "uncertain", processTree });
  }
  throw new TypeError("Guardian spawn result is invalid.");
};

export const admitPtyExit = (
  input: unknown,
  sensitiveValues: readonly string[]
): Readonly<{ readonly exitCode: number | null; readonly signal: string | null }> => {
  const exit = snapshotDataRecord(input, 2);
  if (!exactKeys(exit, ["exitCode", "signal"])) {
    throw new TypeError("Guardian exit result is invalid.");
  }
  const exitCode = exit.exitCode;
  const signal = exit.signal;
  if (
    (exitCode !== null &&
      (!Number.isSafeInteger(exitCode) ||
        (exitCode as number) < 0 ||
        (exitCode as number) > 255)) ||
    (signal !== null && !isDarwinTerminatingSignal(signal)) ||
    (exitCode === null) === (signal === null) ||
    (typeof signal === "string" &&
      sensitiveValues.some((value) => value.length > 0 && signal.includes(value)))
  ) {
    throw new TypeError("Guardian exit result is invalid.");
  }
  return Object.freeze({ exitCode: exitCode as number | null, signal: signal as string | null });
};

export const admitProcessTreeExitProof = (
  input: unknown,
  expectedIdentityDigest: string,
  sensitiveValues: readonly string[]
): ProcessTreeExitProof => {
  const proof = snapshotDataRecord(input, 3);
  if (
    !DIGEST_PATTERN.test(expectedIdentityDigest) ||
    !exactKeys(proof, ["identityDigest", "processTreeTerminated", "exit"]) ||
    proof.identityDigest !== expectedIdentityDigest
  ) {
    throw new TypeError("Guardian process-tree proof is invalid.");
  }
  if (proof.processTreeTerminated === false && proof.exit === null) {
    return Object.freeze({
      identityDigest: expectedIdentityDigest,
      processTreeTerminated: false,
      exit: null
    });
  }
  if (proof.processTreeTerminated !== true) {
    throw new TypeError("Guardian process-tree proof is invalid.");
  }
  return Object.freeze({
    identityDigest: expectedIdentityDigest,
    processTreeTerminated: true,
    exit: admitPtyExit(proof.exit, sensitiveValues)
  });
};
