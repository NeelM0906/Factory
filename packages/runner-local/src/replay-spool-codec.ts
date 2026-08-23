import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve, sep } from "node:path";

import {
  ArtifactIdSchema,
  CommandAuthorizationIdSchema,
  CommandIdSchema,
  EnvironmentAuthorizationIdSchema,
  EnvironmentIdSchema,
  RunnerStreamEventSchema,
  RunIdSchema,
  WorkspaceIdSchema,
  normalizeSafeJson,
  type CommandId,
  type RunnerStreamEvent,
  type SafeJsonValue
} from "@autostack/contracts";

import { snapshotDataRecord, snapshotSafeJson } from "./command-guardian-bounds.js";
import { DataPathPolicy } from "./path-policy.js";
import { isReplaySpoolError, ReplaySpoolError } from "./replay-spool-error.js";
import {
  RECEIPT_PHASES,
  type AdmittedCommandIntent,
  type CommandCancelClaim,
  type CommandCancelAck,
  type CommandExecutionLimits,
  type CommandIntentInput,
  type CommandIntentReceipt,
  type CommandPhaseReceipt,
  type CommandReceiptPhaseName,
  type DurableRunnerFrame,
  type RecordCommandCancelInput
} from "./replay-spool-types.js";

export const EVENT_NAME_PATTERN = /^(\d{12})\.json$/;
export const TRANSCRIPT_NAME_PATTERN = /^(\d{12})\.bin$/;
export const MAXIMUM_EVENTS = 10_000;
export const MAXIMUM_TRANSCRIPT_CHUNKS = 10_000;
export const MAXIMUM_INTENT_BYTES = 128 * 1_024;
export const MAXIMUM_EVENT_BYTES = 128 * 1_024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMAND_INTENT_KEYS = Object.freeze([
  "commandId",
  "workspaceId",
  "runId",
  "environmentId",
  "request",
  "requestDigest",
  "environmentIntentDigest",
  "environmentAuthorizationId",
  "environmentAuthorizationDigest",
  "environmentAuthorization",
  "commandAuthorizationId",
  "commandAuthorizationDigest",
  "acceptedAt",
  "executablePath",
  "executableIdentityDigest",
  "cwdRelativePath",
  "cwdIdentityDigest",
  "spawnEnvelopeDigest",
  "transcriptArtifactId",
  "artifactCreatedAt",
  "guardianSessionBindingDigest",
  "limits"
] as const);
const admittedCommandIntents = new WeakSet<object>();

const exactKeys = (value: object, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
};

const snapshotRunnerEvent = (
  input: unknown,
  errorCode: "invalid_input" | "maintenance_required"
): RunnerStreamEvent => {
  try {
    const parsed = RunnerStreamEventSchema.parse(
      normalizeSafeJson(snapshotSafeJson(input, MAXIMUM_EVENT_BYTES))
    );
    return normalizeSafeJson(parsed) as RunnerStreamEvent;
  } catch {
    throw new ReplaySpoolError(errorCode);
  }
};
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === null) throw new ReplaySpoolError("invalid_input");
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
};

export const digestSpoolValue = (domain: string, value: unknown): string =>
  createHash("sha256")
    .update(canonicalJson({ domain, version: 1, value }), "utf8")
    .digest("hex");

export const isTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 64) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
};

const isAbsoluteSafePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 1 &&
  value.length <= 8_192 &&
  value.startsWith("/") &&
  !value.includes("\0") &&
  !value.includes("\\") &&
  !value.includes("//") &&
  value.split("/").every((segment, index) => index === 0 || (segment !== "." && segment !== ".."));

const isRelativeSafePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4_096 &&
  !value.startsWith("/") &&
  !value.includes("\0") &&
  !value.includes("\\") &&
  (value === "." ||
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."));

const parseDigest = (value: unknown): string => {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new ReplaySpoolError("invalid_input");
  }
  return value;
};

const parseLimits = (value: unknown): CommandExecutionLimits => {
  let candidate: Readonly<Record<string, unknown>>;
  try {
    candidate = snapshotDataRecord(value, 5);
  } catch {
    throw new ReplaySpoolError("invalid_input");
  }
  if (
    !exactKeys(candidate, [
      "eventBytes",
      "replayBytes",
      "transcriptBytes",
      "cancellationGraceMs",
      "eofSettleMs"
    ])
  ) {
    throw new ReplaySpoolError("invalid_input");
  }
  for (const key of [
    "eventBytes",
    "replayBytes",
    "transcriptBytes",
    "cancellationGraceMs",
    "eofSettleMs"
  ] as const) {
    const limit = candidate[key];
    if (
      !Number.isSafeInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > 1_073_741_824
    ) {
      throw new ReplaySpoolError("invalid_input");
    }
  }
  if (
    (candidate.eventBytes as number) < 8_192 ||
    (candidate.replayBytes as number) < 32_768 ||
    (candidate.replayBytes as number) < (candidate.eventBytes as number) * 4 ||
    (candidate.cancellationGraceMs as number) > 60_000 ||
    (candidate.eofSettleMs as number) > 60_000
  ) {
    throw new ReplaySpoolError("invalid_input");
  }
  return Object.freeze({
    eventBytes: candidate.eventBytes as number,
    replayBytes: candidate.replayBytes as number,
    transcriptBytes: candidate.transcriptBytes as number,
    cancellationGraceMs: candidate.cancellationGraceMs as number,
    eofSettleMs: candidate.eofSettleMs as number
  });
};

export const admitIntent = (candidate: CommandIntentInput): AdmittedCommandIntent => {
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    admittedCommandIntents.has(candidate)
  ) {
    return candidate as AdmittedCommandIntent;
  }
  let value: Record<string, unknown>;
  try {
    value = snapshotDataRecord(candidate, COMMAND_INTENT_KEYS.length) as Record<string, unknown>;
  } catch {
    throw new ReplaySpoolError("invalid_input");
  }
  if (!exactKeys(value, COMMAND_INTENT_KEYS)) throw new ReplaySpoolError("invalid_input");
  try {
    const request = normalizeSafeJson(snapshotSafeJson(value.request, MAXIMUM_INTENT_BYTES));
    if (!isAbsoluteSafePath(value.executablePath) || !isRelativeSafePath(value.cwdRelativePath)) {
      throw new TypeError();
    }
    if (!isTimestamp(value.acceptedAt) || !isTimestamp(value.artifactCreatedAt)) {
      throw new TypeError();
    }
    const admitted = Object.freeze({
      commandId: CommandIdSchema.parse(value.commandId),
      workspaceId: WorkspaceIdSchema.parse(value.workspaceId),
      runId: RunIdSchema.parse(value.runId),
      environmentId: EnvironmentIdSchema.parse(value.environmentId),
      request,
      requestDigest: parseDigest(value.requestDigest),
      environmentIntentDigest: parseDigest(value.environmentIntentDigest),
      environmentAuthorizationId: EnvironmentAuthorizationIdSchema.parse(
        value.environmentAuthorizationId
      ),
      environmentAuthorizationDigest: parseDigest(value.environmentAuthorizationDigest),
      environmentAuthorization: normalizeSafeJson(
        snapshotSafeJson(value.environmentAuthorization, MAXIMUM_INTENT_BYTES)
      ),
      commandAuthorizationId: CommandAuthorizationIdSchema.parse(value.commandAuthorizationId),
      commandAuthorizationDigest: parseDigest(value.commandAuthorizationDigest),
      acceptedAt: value.acceptedAt,
      executablePath: value.executablePath,
      executableIdentityDigest: parseDigest(value.executableIdentityDigest),
      cwdRelativePath: value.cwdRelativePath,
      cwdIdentityDigest: parseDigest(value.cwdIdentityDigest),
      spawnEnvelopeDigest: parseDigest(value.spawnEnvelopeDigest),
      transcriptArtifactId: ArtifactIdSchema.parse(value.transcriptArtifactId),
      artifactCreatedAt: value.artifactCreatedAt,
      guardianSessionBindingDigest: parseDigest(value.guardianSessionBindingDigest),
      limits: parseLimits(value.limits)
    });
    admittedCommandIntents.add(admitted);
    return admitted;
  } catch (error) {
    if (isReplaySpoolError(error)) throw error;
    throw new ReplaySpoolError("invalid_input");
  }
};

const receiptWithoutDigest = (intent: AdmittedCommandIntent) => ({
  version: 1 as const,
  kind: "command_receipt" as const,
  phase: "intent" as const,
  sequence: 1 as const,
  previousReceiptDigest: null,
  ...intent
});

export const createIntentReceipt = (intent: AdmittedCommandIntent): CommandIntentReceipt => {
  const base = receiptWithoutDigest(intent);
  return Object.freeze({
    ...base,
    limits: Object.freeze({ ...base.limits }),
    receiptDigest: digestSpoolValue("autostack.command-receipt", base)
  });
};

export const createPhaseReceipt = (
  phase: Exclude<CommandReceiptPhaseName, "intent">,
  sequence: 2 | 3 | 4 | 5 | 6,
  commandId: CommandId,
  previousReceiptDigest: string,
  recordedAt: string,
  evidence: SafeJsonValue
): CommandPhaseReceipt => {
  const base = {
    version: 1 as const,
    kind: "command_receipt" as const,
    phase,
    sequence,
    commandId,
    previousReceiptDigest,
    recordedAt,
    evidence
  };
  return Object.freeze({
    ...base,
    receiptDigest: digestSpoolValue("autostack.command-receipt", base)
  });
};

export const parsePhaseReceipt = (candidate: unknown): CommandPhaseReceipt => {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    !exactKeys(candidate, [
      "version",
      "kind",
      "phase",
      "sequence",
      "commandId",
      "previousReceiptDigest",
      "recordedAt",
      "evidence",
      "receiptDigest"
    ])
  ) {
    throw new ReplaySpoolError("maintenance_required");
  }
  const value = candidate as Record<string, unknown>;
  try {
    if (value.version !== 1 || value.kind !== "command_receipt") throw new TypeError();
    const sequence = value.sequence;
    if (!Number.isInteger(sequence) || (sequence as number) < 2 || (sequence as number) > 6) {
      throw new TypeError();
    }
    const expectedPhase = RECEIPT_PHASES[(sequence as number) - 1];
    if (
      expectedPhase === undefined ||
      expectedPhase === "intent" ||
      value.phase !== expectedPhase
    ) {
      throw new TypeError();
    }
    const commandId = CommandIdSchema.parse(value.commandId);
    const previousReceiptDigest = parseDigest(value.previousReceiptDigest);
    if (!isTimestamp(value.recordedAt)) throw new TypeError();
    const evidence = normalizeSafeJson(value.evidence);
    const receipt = createPhaseReceipt(
      expectedPhase,
      sequence as 2 | 3 | 4 | 5 | 6,
      commandId,
      previousReceiptDigest,
      value.recordedAt,
      evidence
    );
    if (value.receiptDigest !== receipt.receiptDigest) throw new TypeError();
    return receipt;
  } catch {
    throw new ReplaySpoolError("maintenance_required");
  }
};

export const parseIntentReceipt = (candidate: unknown): CommandIntentReceipt => {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new ReplaySpoolError("maintenance_required");
  }
  const value = candidate as Record<string, unknown>;
  if (
    value.version !== 1 ||
    value.kind !== "command_receipt" ||
    value.phase !== "intent" ||
    value.sequence !== 1 ||
    value.previousReceiptDigest !== null ||
    !exactKeys(value, [
      "version",
      "kind",
      "phase",
      "sequence",
      "previousReceiptDigest",
      ...COMMAND_INTENT_KEYS,
      "receiptDigest"
    ])
  ) {
    throw new ReplaySpoolError("maintenance_required");
  }
  try {
    const input = Object.fromEntries(COMMAND_INTENT_KEYS.map((key) => [key, value[key]]));
    const receipt = createIntentReceipt(admitIntent(input as unknown as CommandIntentInput));
    if (value.receiptDigest !== receipt.receiptDigest) {
      throw new ReplaySpoolError("maintenance_required");
    }
    return receipt;
  } catch {
    throw new ReplaySpoolError("maintenance_required");
  }
};

export const commandComponent = (commandId: CommandId): string =>
  Buffer.from(commandId, "utf8").toString("hex");
export const sequenceName = (sequence: number): string =>
  `${String(sequence).padStart(12, "0")}.json`;

export const readBounded = async (
  paths: DataPathPolicy,
  relativePath: string,
  maximumBytes: number
): Promise<Buffer> => {
  const handle = await paths.openFile(relativePath, "r");
  try {
    const status = await handle.stat();
    if (status.size < 1 || status.size > maximumBytes) {
      throw new ReplaySpoolError("maintenance_required");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== status.size) throw new ReplaySpoolError("maintenance_required");
    return bytes;
  } finally {
    await handle.close();
  }
};

/** Read-only publication inspection that tolerates the one exact crash hardlink alias. */
export const readBoundedInspection = async (
  paths: DataPathPolicy,
  relativePath: string,
  maximumBytes: number,
  allowEmpty = false
): Promise<Buffer> => {
  const absolute = resolve(paths.root, relativePath);
  if (!absolute.startsWith(`${paths.root}${sep}`)) {
    throw new ReplaySpoolError("maintenance_required");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const [opened, named] = await Promise.all([handle.stat(), lstat(absolute)]);
    const expectedUid = process.geteuid?.();
    if (
      !opened.isFile() ||
      !named.isFile() ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino ||
      opened.nlink < 1 ||
      opened.nlink > 2 ||
      (opened.mode & 0o777) !== 0o600 ||
      (expectedUid !== undefined && opened.uid !== expectedUid) ||
      (!allowEmpty && opened.size < 1) ||
      opened.size > maximumBytes
    ) {
      throw new ReplaySpoolError("maintenance_required");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== opened.size) throw new ReplaySpoolError("maintenance_required");
    return bytes;
  } catch (error) {
    if (isReplaySpoolError(error)) throw error;
    throw new ReplaySpoolError("maintenance_required");
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

export const parseCanonicalFile = async <Value>(
  paths: DataPathPolicy,
  relativePath: string,
  maximumBytes: number,
  parse: (candidate: unknown) => Value
): Promise<Value> => {
  const bytes = await readBoundedInspection(paths, relativePath, maximumBytes);
  let candidate: unknown;
  try {
    candidate = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ReplaySpoolError("maintenance_required");
  }
  const value = parse(candidate);
  if (!bytes.equals(Buffer.from(canonicalJson(value), "utf8"))) {
    throw new ReplaySpoolError("maintenance_required");
  }
  return value;
};

export const parseFrame = (candidate: unknown): DurableRunnerFrame => {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    !exactKeys(candidate, [
      "version",
      "kind",
      "commandId",
      "sequence",
      "previousFrameDigest",
      "event",
      "eventDigest",
      "frameDigest"
    ])
  ) {
    throw new ReplaySpoolError("maintenance_required");
  }
  const value = candidate as Record<string, unknown>;
  try {
    if (value.version !== 1 || value.kind !== "runner_frame") throw new TypeError();
    const commandId = CommandIdSchema.parse(value.commandId);
    const event = snapshotRunnerEvent(value.event, "maintenance_required");
    const sequence = value.sequence;
    if (
      !Number.isSafeInteger(sequence) ||
      (sequence as number) < 1 ||
      event.sequence !== sequence
    ) {
      throw new TypeError();
    }
    const previousFrameDigest = value.previousFrameDigest;
    if (previousFrameDigest !== null) parseDigest(previousFrameDigest);
    const eventDigest = digestSpoolValue("autostack.runner-event", event);
    if (value.eventDigest !== eventDigest) throw new TypeError();
    const base = {
      version: 1 as const,
      kind: "runner_frame" as const,
      commandId,
      sequence: sequence as number,
      previousFrameDigest: previousFrameDigest as string | null,
      event,
      eventDigest
    };
    const frameDigest = digestSpoolValue("autostack.runner-frame", base);
    if (value.frameDigest !== frameDigest) throw new TypeError();
    return Object.freeze({ ...base, event: Object.freeze(event), frameDigest });
  } catch {
    throw new ReplaySpoolError("maintenance_required");
  }
};

export const createFrame = (
  commandId: CommandId,
  event: RunnerStreamEvent,
  previousFrameDigest: string | null
): DurableRunnerFrame => {
  const immutableEvent = snapshotRunnerEvent(event, "invalid_input");
  const eventDigest = digestSpoolValue("autostack.runner-event", immutableEvent);
  const base = {
    version: 1 as const,
    kind: "runner_frame" as const,
    commandId,
    sequence: immutableEvent.sequence,
    previousFrameDigest,
    event: immutableEvent,
    eventDigest
  };
  return Object.freeze({
    ...base,
    frameDigest: digestSpoolValue("autostack.runner-frame", base)
  });
};

export const createCancelClaim = (
  commandId: CommandId,
  input: RecordCommandCancelInput
): CommandCancelClaim => {
  let admitted: Readonly<Record<string, unknown>>;
  try {
    admitted = snapshotDataRecord(input, 3);
  } catch {
    throw new ReplaySpoolError("invalid_input");
  }
  if (
    !exactKeys(admitted, ["requestDigest", "decidedAt", "cancelled"]) ||
    typeof admitted.requestDigest !== "string" ||
    !SHA256_PATTERN.test(admitted.requestDigest) ||
    typeof admitted.decidedAt !== "string" ||
    !isTimestamp(admitted.decidedAt) ||
    typeof admitted.cancelled !== "boolean"
  ) {
    throw new ReplaySpoolError("invalid_input");
  }
  const base = {
    version: 1 as const,
    kind: "command_cancel" as const,
    commandId,
    requestDigest: admitted.requestDigest,
    decidedAt: admitted.decidedAt,
    cancelled: admitted.cancelled
  };
  return Object.freeze({
    ...base,
    claimDigest: digestSpoolValue("autostack.command-cancel", base)
  });
};

export const admitCancelAckInput = (
  input: unknown
): Readonly<{ readonly claimDigest: string; readonly acknowledgedAt: string }> => {
  let admitted: Readonly<Record<string, unknown>>;
  try {
    admitted = snapshotDataRecord(input, 2);
  } catch {
    throw new ReplaySpoolError("invalid_input");
  }
  if (
    !exactKeys(admitted, ["claimDigest", "acknowledgedAt"]) ||
    typeof admitted.claimDigest !== "string" ||
    !SHA256_PATTERN.test(admitted.claimDigest) ||
    typeof admitted.acknowledgedAt !== "string" ||
    !isTimestamp(admitted.acknowledgedAt)
  ) {
    throw new ReplaySpoolError("invalid_input");
  }
  return Object.freeze({
    claimDigest: admitted.claimDigest,
    acknowledgedAt: admitted.acknowledgedAt
  });
};

export const parseCancelClaim = (candidate: unknown): CommandCancelClaim => {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    !exactKeys(candidate, [
      "version",
      "kind",
      "commandId",
      "requestDigest",
      "decidedAt",
      "cancelled",
      "claimDigest"
    ])
  ) {
    throw new ReplaySpoolError("maintenance_required");
  }
  const value = candidate as Record<string, unknown>;
  try {
    if (value.version !== 1 || value.kind !== "command_cancel") throw new TypeError();
    const claim = createCancelClaim(CommandIdSchema.parse(value.commandId), {
      requestDigest: parseDigest(value.requestDigest),
      decidedAt: value.decidedAt as string,
      cancelled: value.cancelled as boolean
    });
    if (claim.claimDigest !== value.claimDigest) throw new TypeError();
    return claim;
  } catch {
    throw new ReplaySpoolError("maintenance_required");
  }
};

export const createCancelAck = (
  commandId: CommandId,
  claimDigest: string,
  acknowledgedAt: string
): CommandCancelAck => {
  if (!SHA256_PATTERN.test(claimDigest) || !isTimestamp(acknowledgedAt)) {
    throw new ReplaySpoolError("invalid_input");
  }
  const base = {
    version: 1 as const,
    kind: "command_cancel_ack" as const,
    commandId,
    claimDigest,
    acknowledgedAt,
    signalDispatched: true as const
  };
  return Object.freeze({
    ...base,
    ackDigest: digestSpoolValue("autostack.command-cancel-ack", base)
  });
};

export const parseCancelAck = (candidate: unknown): CommandCancelAck => {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    !exactKeys(candidate, [
      "version",
      "kind",
      "commandId",
      "claimDigest",
      "acknowledgedAt",
      "signalDispatched",
      "ackDigest"
    ])
  ) {
    throw new ReplaySpoolError("maintenance_required");
  }
  const value = candidate as Record<string, unknown>;
  try {
    if (
      value.version !== 1 ||
      value.kind !== "command_cancel_ack" ||
      value.signalDispatched !== true
    ) {
      throw new TypeError();
    }
    const ack = createCancelAck(
      CommandIdSchema.parse(value.commandId),
      parseDigest(value.claimDigest),
      value.acknowledgedAt as string
    );
    if (ack.ackDigest !== value.ackDigest) throw new TypeError();
    return ack;
  } catch {
    throw new ReplaySpoolError("maintenance_required");
  }
};
