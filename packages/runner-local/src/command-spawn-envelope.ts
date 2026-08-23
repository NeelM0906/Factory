import { isAbsolute } from "node:path";
import { types as utilTypes } from "node:util";

import {
  CONFIGURED_SECRET_LIMITS,
  StartCommandRequestSchema,
  normalizeSafeJson,
  type StartCommandRequest
} from "@autostack/contracts";

import type { PtyEnvironmentValue, PtySpawnRequest } from "./pty.js";
import type { GuardianBootstrap } from "./command-executor-types.js";
import { snapshotBytes, snapshotDataRecord, snapshotSafeJson } from "./command-guardian-bounds.js";
import { digestSpoolValue } from "./replay-spool-codec.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAXIMUM_ARGUMENTS = 256;
const MAXIMUM_ENVIRONMENT_ENTRIES = 512;
const MAXIMUM_ENVELOPE_BYTES = 2 * 1_048_576;
const COMMAND_ID_PATTERN =
  /^cmd_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !utilTypes.isProxy(value);

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

const exactKeys = (value: object, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
};

const consumeBounded = <Value>(source: Iterable<Value>, maximum: number): readonly Value[] => {
  const values: Value[] = [];
  let iterator: Iterator<Value> | undefined;
  let completed = false;
  try {
    const method = captureDataMethod(source, Symbol.iterator);
    iterator = Reflect.apply(method, undefined, []) as Iterator<Value>;
    const next = captureDataMethod(iterator, "next");
    for (let count = 1; ; count += 1) {
      const result = snapshotIteratorResult<Value>(Reflect.apply(next, undefined, []));
      if (result.done) {
        completed = true;
        break;
      }
      if (count > maximum) throw new TypeError();
      values.push(result.value);
    }
    return values;
  } finally {
    if (!completed && iterator !== undefined) {
      try {
        const close = captureDataMethod(iterator, "return");
        if (typeof close === "function") {
          void Promise.resolve(Reflect.apply(close, undefined, [])).catch(() => undefined);
        }
      } catch {
        // Cleanup is observed without replacing the static bootstrap error.
      }
    }
  }
};

export const snapshotPtySpawnRequest = (input: PtySpawnRequest): PtySpawnRequest => {
  const inputSnapshot = snapshotSafeJson(
    input,
    MAXIMUM_ENVELOPE_BYTES
  ) as unknown as PtySpawnRequest;
  if (
    !isRecord(inputSnapshot) ||
    !exactKeys(inputSnapshot, ["executable", "args", "cwd", "environment", "terminal"])
  ) {
    throw new TypeError("Guardian bootstrap is invalid.");
  }
  const executable = inputSnapshot.executable;
  const cwd = inputSnapshot.cwd;
  if (
    typeof executable !== "string" ||
    !isAbsolute(executable) ||
    executable.includes("\0") ||
    typeof cwd !== "string" ||
    !isAbsolute(cwd) ||
    cwd.includes("\0")
  ) {
    throw new TypeError("Guardian bootstrap is invalid.");
  }
  let aggregateBytes = Buffer.byteLength(executable) + Buffer.byteLength(cwd);
  const args = consumeBounded(inputSnapshot.args, MAXIMUM_ARGUMENTS).map((argument) => {
    if (typeof argument !== "string" || argument.includes("\0")) throw new TypeError();
    aggregateBytes += Buffer.byteLength(argument);
    if (aggregateBytes > MAXIMUM_ENVELOPE_BYTES) throw new TypeError();
    return argument;
  });
  const names = new Set<string>();
  const environment = consumeBounded(inputSnapshot.environment, MAXIMUM_ENVIRONMENT_ENTRIES).map(
    (entry): PtyEnvironmentValue => {
      if (!isRecord(entry) || !exactKeys(entry, ["name", "value"])) throw new TypeError();
      const name = entry.name;
      const value = entry.value;
      if (
        typeof name !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        names.has(name) ||
        typeof value !== "string" ||
        value.includes("\0")
      ) {
        throw new TypeError();
      }
      aggregateBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
      if (aggregateBytes > MAXIMUM_ENVELOPE_BYTES) throw new TypeError();
      names.add(name);
      return Object.freeze({ name, value });
    }
  );
  if (
    !isRecord(inputSnapshot.terminal) ||
    !exactKeys(inputSnapshot.terminal, ["columns", "rows"])
  ) {
    throw new TypeError("Guardian bootstrap is invalid.");
  }
  const columns = inputSnapshot.terminal.columns;
  const rows = inputSnapshot.terminal.rows;
  if (
    !Number.isSafeInteger(columns) ||
    (columns as number) < 20 ||
    (columns as number) > 500 ||
    !Number.isSafeInteger(rows) ||
    (rows as number) < 5 ||
    (rows as number) > 300
  ) {
    throw new TypeError("Guardian bootstrap is invalid.");
  }
  return Object.freeze({
    executable,
    args: Object.freeze(args),
    cwd,
    environment: Object.freeze(environment),
    terminal: Object.freeze({ columns: columns as number, rows: rows as number })
  });
};

export const snapshotSensitiveValues = (source: readonly string[]): readonly string[] => {
  try {
    const values = consumeBounded(source, CONFIGURED_SECRET_LIMITS.maximumCount);
    const snapshot: string[] = [];
    let aggregateCharacters = 0;
    let aggregateBytes = 0;
    for (const value of values) {
      if (typeof value !== "string" || value.length < 1 || value.includes("\0"))
        throw new TypeError();
      aggregateCharacters += value.length;
      aggregateBytes += Buffer.byteLength(value);
      if (
        aggregateCharacters > CONFIGURED_SECRET_LIMITS.maximumAggregateCharacters ||
        aggregateBytes > CONFIGURED_SECRET_LIMITS.maximumAggregateCharacters
      ) {
        throw new TypeError();
      }
      snapshot.push(value);
    }
    return Object.freeze(snapshot);
  } catch {
    throw new TypeError("Guardian bootstrap is invalid.");
  }
};

/** Strict one-shot copy of the authenticated child bootstrap capability. */
export const snapshotGuardianBootstrap = (input: GuardianBootstrap): GuardianBootstrap => {
  try {
    const candidate = snapshotDataRecord(input, 12);
    if (
      !exactKeys(candidate, [
        "dataRoot",
        "commandId",
        "intentRelativePath",
        "envelope",
        "sensitiveValues",
        "timeoutMs",
        "cancellationGraceMs",
        "eofSettleMs",
        "executableIdentityDigest",
        "cwdIdentityDigest",
        "session"
      ])
    ) {
      throw new TypeError();
    }
    const dataRoot = candidate.dataRoot;
    const commandId = candidate.commandId;
    const intentRelativePath = candidate.intentRelativePath;
    const timeoutMs = candidate.timeoutMs;
    const cancellationGraceMs = candidate.cancellationGraceMs;
    const eofSettleMs = candidate.eofSettleMs;
    const executableIdentityDigest = candidate.executableIdentityDigest;
    const cwdIdentityDigest = candidate.cwdIdentityDigest;
    if (
      typeof dataRoot !== "string" ||
      !isAbsolute(dataRoot) ||
      dataRoot.includes("\0") ||
      typeof commandId !== "string" ||
      !COMMAND_ID_PATTERN.test(commandId) ||
      typeof intentRelativePath !== "string" ||
      intentRelativePath.length > 8_192 ||
      !Number.isSafeInteger(timeoutMs) ||
      (timeoutMs as number) < 1 ||
      (timeoutMs as number) > 86_400_000 ||
      !Number.isSafeInteger(cancellationGraceMs) ||
      (cancellationGraceMs as number) < 1 ||
      (cancellationGraceMs as number) > 60_000 ||
      !Number.isSafeInteger(eofSettleMs) ||
      (eofSettleMs as number) < 1 ||
      (eofSettleMs as number) > 60_000 ||
      typeof executableIdentityDigest !== "string" ||
      !SHA256_PATTERN.test(executableIdentityDigest) ||
      typeof cwdIdentityDigest !== "string" ||
      !SHA256_PATTERN.test(cwdIdentityDigest)
    ) {
      throw new TypeError();
    }
    const expectedIntentRelativePath = `commands/${Buffer.from(commandId, "utf8").toString("hex")}/receipt/01-intent.json`;
    if (intentRelativePath !== expectedIntentRelativePath) throw new TypeError();
    const sessionInput = snapshotDataRecord(candidate.session, 3);
    if (
      !isRecord(sessionInput) ||
      !exactKeys(sessionInput, ["sessionId", "secret", "bindingDigest"])
    ) {
      throw new TypeError();
    }
    const sessionId = sessionInput.sessionId;
    const bindingDigest = sessionInput.bindingDigest;
    const secretInput = sessionInput.secret;
    if (
      typeof sessionId !== "string" ||
      sessionId.length < 1 ||
      sessionId.length > 256 ||
      typeof bindingDigest !== "string" ||
      !SHA256_PATTERN.test(bindingDigest)
    ) {
      throw new TypeError();
    }
    return Object.freeze({
      dataRoot,
      commandId: commandId as GuardianBootstrap["commandId"],
      intentRelativePath,
      envelope: snapshotPtySpawnRequest(candidate.envelope as PtySpawnRequest),
      sensitiveValues: snapshotSensitiveValues(candidate.sensitiveValues as readonly string[]),
      timeoutMs: timeoutMs as number,
      cancellationGraceMs: cancellationGraceMs as number,
      eofSettleMs: eofSettleMs as number,
      executableIdentityDigest,
      cwdIdentityDigest,
      session: Object.freeze({
        sessionId,
        secret: snapshotBytes(secretInput, { maximumBytes: 32, exactBytes: 32 }),
        bindingDigest
      })
    });
  } catch {
    throw new TypeError("Guardian bootstrap is invalid.");
  }
};

export const digestSpawnEnvelope = (input: {
  readonly request: StartCommandRequest;
  readonly envelope: PtySpawnRequest;
  readonly executableIdentityDigest: string;
  readonly cwdIdentityDigest: string;
  readonly sensitiveValues: readonly string[];
}): string => {
  const request = StartCommandRequestSchema.parse(normalizeSafeJson(input.request));
  const envelope = snapshotPtySpawnRequest(input.envelope);
  if (
    !SHA256_PATTERN.test(input.executableIdentityDigest) ||
    !SHA256_PATTERN.test(input.cwdIdentityDigest) ||
    envelope.args.length !== request.command.args.length ||
    envelope.args.some((argument, index) => argument !== request.command.args[index]) ||
    envelope.terminal.columns !== request.command.terminal.columns ||
    envelope.terminal.rows !== request.command.terminal.rows
  ) {
    throw new TypeError("Guardian bootstrap is invalid.");
  }
  const commandEnvironment = request.command.environment;
  if (envelope.environment.length < commandEnvironment.length) {
    throw new TypeError("Guardian bootstrap is invalid.");
  }
  const baselineCount = envelope.environment.length - commandEnvironment.length;
  const environmentEvidence: unknown[] = [];
  const credentialValues: string[] = [];
  for (let index = 0; index < envelope.environment.length; index += 1) {
    const actual = envelope.environment[index]!;
    const requested = commandEnvironment[index - baselineCount];
    if (requested === undefined) {
      environmentEvidence.push({ kind: "baseline", name: actual.name, value: actual.value });
      continue;
    }
    if (actual.name !== requested.name) throw new TypeError("Guardian bootstrap is invalid.");
    if (requested.kind === "literal") {
      if (actual.value !== requested.value) throw new TypeError("Guardian bootstrap is invalid.");
      environmentEvidence.push({ kind: "literal", name: actual.name, value: actual.value });
    } else {
      if (actual.value.length < 1) throw new TypeError("Guardian bootstrap is invalid.");
      credentialValues.push(actual.value);
      environmentEvidence.push({
        kind: "credential_ref",
        name: actual.name,
        credentialRefId: requested.credentialRefId
      });
    }
  }
  const sensitiveValues = snapshotSensitiveValues(input.sensitiveValues);
  if (
    sensitiveValues.length !== credentialValues.length ||
    sensitiveValues.some((value, index) => value !== credentialValues[index])
  ) {
    throw new TypeError("Guardian bootstrap is invalid.");
  }
  return digestSpoolValue("autostack.command-spawn-envelope", {
    executable: envelope.executable,
    args: envelope.args,
    cwdPathDigest: digestSpoolValue("autostack.command-cwd-path", envelope.cwd),
    environment: environmentEvidence,
    terminal: envelope.terminal,
    timeoutSeconds: request.command.timeoutSeconds,
    executableIdentityDigest: input.executableIdentityDigest,
    cwdIdentityDigest: input.cwdIdentityDigest
  });
};
