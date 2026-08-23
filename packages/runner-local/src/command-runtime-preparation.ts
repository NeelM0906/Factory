import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { types as utilTypes } from "node:util";

import {
  CONFIGURED_SECRET_LIMITS,
  containsSensitiveMaterial,
  type CredentialRefId,
  type StartCommandRequest
} from "@autostack/contracts";

import { isForbiddenEnvironmentName } from "./command-environment-policy.js";
import { createCommandExecutorError } from "./command-executor-error.js";
import type {
  GuardianSessionMaterial,
  ResolvedCommandCredential,
  ResolvedExecutable
} from "./command-executor-types.js";
import type { PtyEnvironmentValue } from "./pty.js";
import { snapshotBytes } from "./command-guardian-bounds.js";
import { DataPathPolicy } from "./path-policy.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const BASELINE_NAMES = Object.freeze(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"]);

const captureDataMethod = (input: unknown, name: PropertyKey): ((...args: never[]) => unknown) => {
  if (
    (typeof input !== "object" && typeof input !== "function") ||
    input === null ||
    utilTypes.isProxy(input)
  ) {
    throw new TypeError();
  }
  let current: object | null = input;
  while (current !== null) {
    if (utilTypes.isProxy(current)) throw new TypeError();
    const descriptor = Reflect.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") throw new TypeError();
      const method = descriptor.value as (...args: never[]) => unknown;
      return (...args: never[]) => Reflect.apply(method, input, args);
    }
    current = Reflect.getPrototypeOf(current);
  }
  throw new TypeError();
};

const snapshotIteratorResult = <Value>(input: unknown): IteratorResult<Value> => {
  if (typeof input !== "object" || input === null || utilTypes.isProxy(input))
    throw new TypeError();
  const done = Reflect.getOwnPropertyDescriptor(input, "done");
  const value = Reflect.getOwnPropertyDescriptor(input, "value");
  if (done === undefined || !("value" in done) || typeof done.value !== "boolean") {
    throw new TypeError();
  }
  if (done.value) return Object.freeze({ done: true, value: undefined });
  if (value === undefined || !("value" in value)) throw new TypeError();
  return Object.freeze({ done: false, value: value.value as Value });
};

export interface PinnedCwd {
  readonly canonicalPath: string;
  readonly relativePath: string;
  readonly identityDigest: string;
  revalidate(): Promise<boolean>;
}

const consumeBounded = <Value>(source: Iterable<Value>, maximum: number): readonly Value[] => {
  const values: Value[] = [];
  let iterator: Iterator<Value> | undefined;
  let completed = false;
  try {
    const iteratorMethod = captureDataMethod(source, Symbol.iterator);
    iterator = Reflect.apply(iteratorMethod, undefined, []) as Iterator<Value>;
    const next = captureDataMethod(iterator, "next");
    for (let yielded = 1; ; yielded += 1) {
      const result = snapshotIteratorResult<Value>(Reflect.apply(next, undefined, []));
      if (result.done) {
        completed = true;
        break;
      }
      if (yielded > maximum) throw new TypeError();
      values.push(result.value);
    }
    return values;
  } finally {
    if (!completed && iterator !== undefined) {
      try {
        const close = captureDataMethod(iterator, "return");
        if (typeof close === "function") {
          const cleanup = Reflect.apply(close, undefined, []) as unknown;
          void Promise.resolve(cleanup).catch(() => undefined);
        }
      } catch {
        // Cleanup is observed best-effort without replacing the static admission error.
      }
    }
  }
};

const isSafeAbsolutePath = (value: string): boolean =>
  isAbsolute(value) &&
  !value.includes("\0") &&
  !value.includes("\\") &&
  !value.includes("//") &&
  resolve(value) === value;

export const snapshotTrustedBaseEnvironment = (
  dataRoot: string,
  source: readonly PtyEnvironmentValue[]
): readonly PtyEnvironmentValue[] => {
  try {
    if (!isSafeAbsolutePath(dataRoot)) throw new TypeError();
    const values = consumeBounded(source, BASELINE_NAMES.length);
    if (values.length !== BASELINE_NAMES.length) throw new TypeError();
    const snapshot: PtyEnvironmentValue[] = [];
    for (let index = 0; index < BASELINE_NAMES.length; index += 1) {
      const value = values[index];
      const expectedName = BASELINE_NAMES[index];
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        utilTypes.isProxy(value)
      )
        throw new TypeError();
      const keys = Reflect.ownKeys(value);
      if (keys.length !== 2 || keys.some((key) => key !== "name" && key !== "value")) {
        throw new TypeError();
      }
      const nameDescriptor = Reflect.getOwnPropertyDescriptor(value, "name");
      const valueDescriptor = Reflect.getOwnPropertyDescriptor(value, "value");
      if (
        nameDescriptor === undefined ||
        valueDescriptor === undefined ||
        !("value" in nameDescriptor) ||
        !("value" in valueDescriptor) ||
        nameDescriptor.enumerable !== true ||
        valueDescriptor.enumerable !== true
      ) {
        throw new TypeError();
      }
      const name = nameDescriptor.value as unknown;
      const entryValue = valueDescriptor.value as unknown;
      if (
        typeof name !== "string" ||
        name !== expectedName ||
        typeof entryValue !== "string" ||
        entryValue.includes("\0") ||
        containsSensitiveMaterial(entryValue)
      ) {
        throw new TypeError();
      }
      snapshot.push(Object.freeze({ name, value: entryValue }));
    }
    const byName = new Map(snapshot.map((entry) => [entry.name, entry.value]));
    const path = byName.get("PATH")!;
    const home = byName.get("HOME")!;
    const temporary = byName.get("TMPDIR")!;
    if (
      path.split(":").some((entry) => !isSafeAbsolutePath(entry)) ||
      !isSafeAbsolutePath(home) ||
      !isSafeAbsolutePath(temporary) ||
      !isWithin(dataRoot, home) ||
      !isWithin(dataRoot, temporary) ||
      home === temporary ||
      byName.get("LANG") !== "C" ||
      byName.get("LC_ALL") !== "C" ||
      byName.get("TERM") !== "xterm-256color"
    ) {
      throw new TypeError();
    }
    return Object.freeze(snapshot);
  } catch {
    throw createCommandExecutorError("invalid_request");
  }
};

export const validateTrustedBaseEnvironmentPaths = async (
  dataRoot: string,
  environment: readonly PtyEnvironmentValue[]
): Promise<void> => {
  try {
    const paths = await DataPathPolicy.openExisting(dataRoot);
    const canonicalRoot = await realpath(dataRoot);
    const values = new Map(environment.map((entry) => [entry.name, entry.value]));
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    for (const name of ["HOME", "TMPDIR"] as const) {
      const path = values.get(name);
      if (path === undefined || !isSafeAbsolutePath(path) || !isWithin(dataRoot, path)) {
        throw new TypeError();
      }
      await paths.ensureDirectory(relative(dataRoot, path));
      const before = await lstat(path);
      const canonical = await realpath(path);
      const expectedCanonical = resolve(canonicalRoot, relative(dataRoot, path));
      if (
        canonical !== expectedCanonical ||
        before.isSymbolicLink() ||
        !before.isDirectory() ||
        (before.mode & 0o777) !== 0o700 ||
        (expectedUid !== undefined && before.uid !== expectedUid)
      ) {
        throw new TypeError();
      }
      const after = await lstat(path);
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.mode !== before.mode ||
        after.uid !== before.uid
      ) {
        throw new TypeError();
      }
    }
  } catch {
    throw createCommandExecutorError("invalid_request");
  }
};

export const planCommandPrivateBaseEnvironment = (
  dataRoot: string,
  commandId: string,
  baseline: readonly PtyEnvironmentValue[]
): readonly PtyEnvironmentValue[] => {
  try {
    if (!/^cmd_[0-9a-f-]{36}$/i.test(commandId)) throw new TypeError();
    const component = Buffer.from(commandId, "utf8").toString("hex");
    const commandRuntimeRoot = resolve(dataRoot, "runtime", "commands", component);
    const home = resolve(commandRuntimeRoot, "home");
    const temporary = resolve(commandRuntimeRoot, "tmp");
    return Object.freeze(
      baseline.map((entry) =>
        Object.freeze({
          name: entry.name,
          value: entry.name === "HOME" ? home : entry.name === "TMPDIR" ? temporary : entry.value
        })
      )
    );
  } catch {
    throw createCommandExecutorError("execution_unavailable");
  }
};

export const createCommandPrivateBaseEnvironment = async (
  dataRoot: string,
  commandId: string,
  baseline: readonly PtyEnvironmentValue[]
): Promise<readonly PtyEnvironmentValue[]> => {
  try {
    const environment = planCommandPrivateBaseEnvironment(dataRoot, commandId, baseline);
    await validateTrustedBaseEnvironmentPaths(dataRoot, environment);
    return environment;
  } catch {
    throw createCommandExecutorError("execution_unavailable");
  }
};

const isWithin = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
};

const assertNoSymlinkComponents = async (root: string, relativePath: string): Promise<void> => {
  let current = root;
  for (const component of relativePath === "." ? [] : relativePath.split("/")) {
    current = resolve(current, component);
    if ((await lstat(current)).isSymbolicLink()) throw new TypeError();
  }
};

export const pinCommandCwd = async (managedPath: string, cwd: string): Promise<PinnedCwd> => {
  try {
    const canonicalRoot = await realpath(managedPath);
    const unresolvedPath = resolve(canonicalRoot, cwd);
    await assertNoSymlinkComponents(canonicalRoot, cwd);
    const canonicalPath = await realpath(unresolvedPath);
    if (!isWithin(canonicalRoot, canonicalPath)) throw new TypeError();
    const identity = await lstat(canonicalPath);
    if (!identity.isDirectory() || identity.isSymbolicLink()) throw new TypeError();
    const identityInput = `${canonicalPath}\0${identity.dev.toString()}\0${identity.ino.toString()}`;
    const identityDigest = createHash("sha256").update(identityInput).digest("hex");
    return Object.freeze({
      canonicalPath,
      relativePath: cwd,
      identityDigest,
      async revalidate() {
        try {
          await assertNoSymlinkComponents(canonicalRoot, cwd);
          const currentPath = await realpath(unresolvedPath);
          const current = await lstat(unresolvedPath);
          const currentInput = `${currentPath}\0${current.dev.toString()}\0${current.ino.toString()}`;
          return (
            currentPath === canonicalPath &&
            current.isDirectory() &&
            !current.isSymbolicLink() &&
            createHash("sha256").update(currentInput).digest("hex") === identityDigest
          );
        } catch {
          return false;
        }
      }
    });
  } catch {
    throw createCommandExecutorError("environment_conflict");
  }
};

export const snapshotResolvedExecutable = (value: ResolvedExecutable): ResolvedExecutable => {
  try {
    if (utilTypes.isProxy(value)) throw new TypeError();
    const canonicalPathDescriptor = Reflect.getOwnPropertyDescriptor(value, "canonicalPath");
    const identityDescriptor = Reflect.getOwnPropertyDescriptor(value, "identityDigest");
    if (
      canonicalPathDescriptor === undefined ||
      !("value" in canonicalPathDescriptor) ||
      identityDescriptor === undefined ||
      !("value" in identityDescriptor)
    )
      throw new TypeError();
    const canonicalPath = canonicalPathDescriptor.value as unknown;
    const identityDigest = identityDescriptor.value as unknown;
    const revalidate = captureDataMethod(value, "revalidate");
    if (
      typeof canonicalPath !== "string" ||
      !isAbsolute(canonicalPath) ||
      canonicalPath.includes("\0") ||
      typeof identityDigest !== "string" ||
      !SHA256_PATTERN.test(identityDigest) ||
      typeof revalidate !== "function"
    ) {
      throw new TypeError();
    }
    return Object.freeze({
      canonicalPath,
      identityDigest,
      revalidate: revalidate as ResolvedExecutable["revalidate"]
    });
  } catch {
    throw createCommandExecutorError("execution_unavailable");
  }
};

export const snapshotGuardianSession = (
  value: GuardianSessionMaterial
): GuardianSessionMaterial => {
  try {
    if (typeof value !== "object" || value === null || utilTypes.isProxy(value))
      throw new TypeError();
    const sessionIdDescriptor = Reflect.getOwnPropertyDescriptor(value, "sessionId");
    const bindingDescriptor = Reflect.getOwnPropertyDescriptor(value, "bindingDigest");
    const secretDescriptor = Reflect.getOwnPropertyDescriptor(value, "secret");
    if (
      sessionIdDescriptor === undefined ||
      !("value" in sessionIdDescriptor) ||
      bindingDescriptor === undefined ||
      !("value" in bindingDescriptor) ||
      secretDescriptor === undefined ||
      !("value" in secretDescriptor)
    )
      throw new TypeError();
    const sessionId = sessionIdDescriptor.value as unknown;
    const suppliedBindingDigest = bindingDescriptor.value as unknown;
    const secret = snapshotBytes(secretDescriptor.value, {
      maximumBytes: 32,
      exactBytes: 32
    });
    if (
      typeof sessionId !== "string" ||
      !SESSION_ID_PATTERN.test(sessionId) ||
      typeof suppliedBindingDigest !== "string" ||
      !SHA256_PATTERN.test(suppliedBindingDigest)
    ) {
      throw new TypeError();
    }
    const bindingDigest = createHash("sha256")
      .update("autostack.guardian-session-binding/v1\0", "utf8")
      .update(sessionId, "utf8")
      .update("\0", "utf8")
      .update(secret)
      .digest("hex");
    return Object.freeze({ sessionId, bindingDigest, secret });
  } catch {
    throw createCommandExecutorError("execution_unavailable");
  }
};

export const snapshotCommandCredentials = (
  values: readonly ResolvedCommandCredential[],
  expected: readonly CredentialRefId[]
): ReadonlyMap<CredentialRefId, string> => {
  try {
    const result = new Map<CredentialRefId, string>();
    let aggregateBytes = 0;
    let aggregateCharacters = 0;
    for (const value of consumeBounded(values, CONFIGURED_SECRET_LIMITS.maximumCount)) {
      if (typeof value !== "object" || value === null || utilTypes.isProxy(value))
        throw new TypeError();
      const idDescriptor = Reflect.getOwnPropertyDescriptor(value, "credentialRefId");
      const valueDescriptor = Reflect.getOwnPropertyDescriptor(value, "value");
      if (
        idDescriptor === undefined ||
        !("value" in idDescriptor) ||
        valueDescriptor === undefined ||
        !("value" in valueDescriptor)
      )
        throw new TypeError();
      const credentialRefId = idDescriptor.value as CredentialRefId;
      const secret = valueDescriptor.value as unknown;
      const byteLength = typeof secret === "string" ? Buffer.byteLength(secret) : 0;
      aggregateBytes += byteLength;
      aggregateCharacters += typeof secret === "string" ? secret.length : 0;
      if (
        !expected.includes(credentialRefId) ||
        result.has(credentialRefId) ||
        typeof secret !== "string" ||
        secret.length < 1 ||
        secret.includes("\0") ||
        byteLength > CONFIGURED_SECRET_LIMITS.maximumAggregateCharacters ||
        aggregateBytes > CONFIGURED_SECRET_LIMITS.maximumAggregateCharacters ||
        aggregateCharacters > CONFIGURED_SECRET_LIMITS.maximumAggregateCharacters
      ) {
        throw new TypeError();
      }
      result.set(credentialRefId, secret);
    }
    if (result.size !== expected.length) throw new TypeError();
    return result;
  } catch {
    throw createCommandExecutorError("execution_unavailable");
  }
};

export const validateCommandEnvironmentNames = (
  base: readonly PtyEnvironmentValue[],
  request: StartCommandRequest
): void => {
  const names = new Set(base.map(({ name }) => name));
  for (const entry of request.command.environment) {
    if (isForbiddenEnvironmentName(entry.name) || names.has(entry.name)) {
      throw createCommandExecutorError("invalid_request");
    }
    names.add(entry.name);
  }
};

export const materializeCommandEnvironment = (
  base: readonly PtyEnvironmentValue[],
  request: StartCommandRequest,
  credentials: ReadonlyMap<CredentialRefId, string>
): readonly PtyEnvironmentValue[] => {
  validateCommandEnvironmentNames(base, request);
  const environment = base.map((entry) => Object.freeze({ ...entry }));
  for (const entry of request.command.environment) {
    const value = entry.kind === "literal" ? entry.value : credentials.get(entry.credentialRefId);
    if (value === undefined) throw createCommandExecutorError("execution_unavailable");
    environment.push(Object.freeze({ name: entry.name, value }));
  }
  return Object.freeze(environment);
};
