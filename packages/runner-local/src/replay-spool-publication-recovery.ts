import { createHash } from "node:crypto";

import { DataPathPolicy } from "./path-policy.js";
import {
  EVENT_NAME_PATTERN,
  MAXIMUM_EVENTS,
  MAXIMUM_EVENT_BYTES,
  MAXIMUM_INTENT_BYTES,
  MAXIMUM_TRANSCRIPT_CHUNKS,
  TRANSCRIPT_NAME_PATTERN,
  canonicalJson,
  digestSpoolValue,
  parseCancelClaim,
  parseCancelAck,
  parseFrame,
  parseIntentReceipt,
  parsePhaseReceipt,
  parseCanonicalFile,
  readBoundedInspection,
  sequenceName
} from "./replay-spool-codec.js";
import { ReplaySpoolError } from "./replay-spool-error.js";
import {
  RECEIPT_NAMES,
  type CommandCancelAck,
  type CommandCancelClaim,
  type CommandIntentReceipt,
  type CommandPhaseReceipt,
  type DurableRunnerFrame,
  type RecoveredCommandSpool,
  type RecoveredTranscriptChunk
} from "./replay-spool-types.js";

const TEMPORARY_NAME_PATTERN = /^\.(.+)\.([0-9a-f]{32})\.tmp$/;
const TRANSCRIPT_TEMPORARY_NAME_PATTERN =
  /^\.(\d{12}\.bin)\.([0-9a-f]{64})\.(\d{1,7})\.([0-9a-f]{32})\.tmp$/;

type ByteValidator = (canonicalName: string, bytes: Buffer) => boolean;
type MutationGuard = (() => void) | undefined;

const inspectExistingDirectory = async (
  paths: DataPathPolicy,
  directory: string,
  maximumEntries: number
) => {
  try {
    const entries = await paths.listExistingDirectory(directory, maximumEntries);
    if (entries === undefined) throw new ReplaySpoolError("maintenance_required");
    return entries;
  } catch {
    throw new ReplaySpoolError("maintenance_required");
  }
};

const inspectCandidates = async (
  paths: DataPathPolicy,
  directory: string,
  accepts: (canonicalName: string) => boolean,
  maximumBytes: number,
  maximumEntries: number,
  maximumAggregateBytes: number
): Promise<Map<string, Buffer>> => {
  const candidates = new Map<string, Buffer[]>();
  let aggregateBytes = 0;
  for (const entry of await inspectExistingDirectory(paths, directory, maximumEntries)) {
    if (entry.type !== "file") throw new ReplaySpoolError("maintenance_required");
    const match = TEMPORARY_NAME_PATTERN.exec(entry.name);
    const canonicalName = match?.[1] ?? entry.name;
    if (canonicalName === undefined || !accepts(canonicalName)) {
      throw new ReplaySpoolError("maintenance_required");
    }
    const bytes = await readTemporary(paths, `${directory}/${entry.name}`, maximumBytes);
    aggregateBytes += bytes.byteLength;
    if (aggregateBytes > maximumAggregateBytes) {
      throw new ReplaySpoolError("maintenance_required");
    }
    if (match !== null && bytes.byteLength === 0) continue;
    const values = candidates.get(canonicalName) ?? [];
    values.push(bytes);
    candidates.set(canonicalName, values);
  }
  const logical = new Map<string, Buffer>();
  for (const [name, values] of candidates) {
    const first = values[0];
    if (first === undefined || values.some((value) => !value.equals(first))) {
      throw new ReplaySpoolError("maintenance_required");
    }
    logical.set(name, first);
  }
  return logical;
};

const inspectReceiptHistory = async (
  paths: DataPathPolicy,
  commandRoot: string,
  expectedCommandId?: string,
  expectedIntentDigest?: string,
  allowEmpty = false
): Promise<
  | Readonly<{
      intent: CommandIntentReceipt;
      phases: readonly (CommandIntentReceipt | CommandPhaseReceipt)[];
    }>
  | undefined
> => {
  const candidates = await inspectCandidates(
    paths,
    `${commandRoot}/receipt`,
    (name) => RECEIPT_NAMES.includes(name as never),
    MAXIMUM_INTENT_BYTES,
    RECEIPT_NAMES.length * 2,
    MAXIMUM_INTENT_BYTES * RECEIPT_NAMES.length * 2
  );
  const names = [...candidates.keys()].sort();
  if (names.length === 0 && allowEmpty) return undefined;
  const phases: (CommandIntentReceipt | CommandPhaseReceipt)[] = [];
  let previous: CommandIntentReceipt | CommandPhaseReceipt | undefined;
  for (const [index, name] of names.entries()) {
    if (name !== RECEIPT_NAMES[index]) throw new ReplaySpoolError("maintenance_required");
    const bytes = candidates.get(name)!;
    const parsed =
      index === 0
        ? parseIntentReceipt(JSON.parse(bytes.toString("utf8")))
        : parsePhaseReceipt(JSON.parse(bytes.toString("utf8")));
    if (!bytes.equals(Buffer.from(canonicalJson(parsed), "utf8"))) {
      throw new ReplaySpoolError("maintenance_required");
    }
    if (
      (expectedCommandId !== undefined && parsed.commandId !== expectedCommandId) ||
      (index === 0 &&
        expectedIntentDigest !== undefined &&
        parsed.receiptDigest !== expectedIntentDigest)
    ) {
      throw new ReplaySpoolError("maintenance_required");
    }
    if (index > 0) {
      if (
        parsed.phase !==
          (["lease_transferred", "spawned", "running", "finalizing", "terminal"] as const)[
            index - 1
          ] ||
        parsed.sequence !== index + 1 ||
        parsed.previousReceiptDigest !== previous?.receiptDigest ||
        Date.parse(parsed.recordedAt) <=
          Date.parse(
            previous?.phase === "intent" ? previous.acceptedAt : (previous?.recordedAt ?? "")
          )
      ) {
        throw new ReplaySpoolError("maintenance_required");
      }
    }
    phases.push(parsed);
    previous = parsed;
  }
  const intent = phases[0];
  if (intent?.phase !== "intent") throw new ReplaySpoolError("maintenance_required");
  return Object.freeze({ intent, phases: Object.freeze(phases) });
};

const inspectSpoolHistory = async (
  paths: DataPathPolicy,
  commandRoot: string,
  intent: CommandIntentReceipt
): Promise<
  Readonly<{
    events: readonly DurableRunnerFrame[];
    eventByteSize: number;
    transcriptChunks: readonly RecoveredTranscriptChunk[];
    transcriptByteSize: number;
    cancel?: CommandCancelClaim;
    cancelAck?: CommandCancelAck;
  }>
> => {
  const controls = await inspectCandidates(
    paths,
    `${commandRoot}/control`,
    (name) => name === "cancel.json" || name === "cancel-ack.json",
    MAXIMUM_INTENT_BYTES,
    4,
    MAXIMUM_INTENT_BYTES * 4
  );
  const cancelBytes = controls.get("cancel.json");
  const ackBytes = controls.get("cancel-ack.json");
  const cancel =
    cancelBytes === undefined
      ? undefined
      : parseCancelClaim(JSON.parse(cancelBytes.toString("utf8")));
  const ack =
    ackBytes === undefined ? undefined : parseCancelAck(JSON.parse(ackBytes.toString("utf8")));
  if (
    (cancelBytes !== undefined &&
      !cancelBytes.equals(Buffer.from(canonicalJson(cancel), "utf8"))) ||
    (ackBytes !== undefined && !ackBytes.equals(Buffer.from(canonicalJson(ack), "utf8"))) ||
    cancel?.commandId !== (cancel === undefined ? undefined : intent.commandId) ||
    (ack !== undefined &&
      (cancel === undefined ||
        ack.commandId !== intent.commandId ||
        ack.claimDigest !== cancel.claimDigest ||
        Date.parse(ack.acknowledgedAt) < Date.parse(cancel.decidedAt)))
  ) {
    throw new ReplaySpoolError("maintenance_required");
  }
  const events = await inspectCandidates(
    paths,
    `${commandRoot}/spool/events`,
    (name) => EVENT_NAME_PATTERN.test(name),
    Math.min(MAXIMUM_EVENT_BYTES, intent.limits.eventBytes),
    MAXIMUM_EVENTS * 2,
    intent.limits.replayBytes * 2
  );
  const names = [...events.keys()].sort();
  if (names.length > MAXIMUM_EVENTS) throw new ReplaySpoolError("maintenance_required");
  const frames: DurableRunnerFrame[] = [];
  let eventByteSize = 0;
  let previousDigest: string | null = null;
  for (const [index, name] of names.entries()) {
    const sequence = index + 1;
    if (name !== sequenceName(sequence)) throw new ReplaySpoolError("maintenance_required");
    const bytes = events.get(name)!;
    const frame = parseFrame(JSON.parse(bytes.toString("utf8")));
    if (
      frame.commandId !== intent.commandId ||
      frame.sequence !== sequence ||
      frame.previousFrameDigest !== previousDigest ||
      !bytes.equals(Buffer.from(canonicalJson(frame), "utf8"))
    ) {
      throw new ReplaySpoolError("maintenance_required");
    }
    eventByteSize += bytes.byteLength;
    if (eventByteSize > intent.limits.replayBytes) {
      throw new ReplaySpoolError("maintenance_required");
    }
    frames.push(frame);
    previousDigest = frame.frameDigest;
  }
  const transcriptDirectory = `${commandRoot}/spool/transcript`;
  const maximumTranscriptBytes = Math.min(1_048_576, intent.limits.transcriptBytes);
  const transcriptCandidates = new Map<string, Buffer[]>();
  let aggregateTranscriptBytes = 0;
  for (const entry of await inspectExistingDirectory(
    paths,
    transcriptDirectory,
    MAXIMUM_TRANSCRIPT_CHUNKS * 2
  )) {
    if (entry.type !== "file") throw new ReplaySpoolError("maintenance_required");
    const identified = entry.name.startsWith(".")
      ? TRANSCRIPT_TEMPORARY_NAME_PATTERN.exec(entry.name)
      : null;
    const legacy = entry.name.startsWith(".") ? TEMPORARY_NAME_PATTERN.exec(entry.name) : null;
    const canonicalName = identified?.[1] ?? legacy?.[1] ?? entry.name;
    if (canonicalName === undefined || !TRANSCRIPT_NAME_PATTERN.test(canonicalName)) {
      throw new ReplaySpoolError("maintenance_required");
    }
    const bytes = await readTemporary(
      paths,
      `${transcriptDirectory}/${entry.name}`,
      maximumTranscriptBytes
    );
    aggregateTranscriptBytes += bytes.byteLength;
    if (aggregateTranscriptBytes > intent.limits.transcriptBytes * 2) {
      throw new ReplaySpoolError("maintenance_required");
    }
    if (entry.name.startsWith(".") && bytes.byteLength === 0) continue;
    if (
      entry.name.startsWith(".") &&
      (identified === null ||
        identified[2] !== createHash("sha256").update(bytes).digest("hex") ||
        Number(identified[3]) !== bytes.byteLength)
    ) {
      throw new ReplaySpoolError("maintenance_required");
    }
    if (bytes.byteLength === 0) throw new ReplaySpoolError("maintenance_required");
    const values = transcriptCandidates.get(canonicalName) ?? [];
    values.push(bytes);
    transcriptCandidates.set(canonicalName, values);
  }
  const transcriptNames = [...transcriptCandidates.keys()].sort();
  if (transcriptNames.length > MAXIMUM_TRANSCRIPT_CHUNKS) {
    throw new ReplaySpoolError("maintenance_required");
  }
  const transcriptChunks: RecoveredTranscriptChunk[] = [];
  let transcriptByteSize = 0;
  for (const [index, name] of transcriptNames.entries()) {
    const ordinal = index + 1;
    if (name !== `${String(ordinal).padStart(12, "0")}.bin`) {
      throw new ReplaySpoolError("maintenance_required");
    }
    const values = transcriptCandidates.get(name)!;
    const bytes = values[0];
    if (bytes === undefined || values.some((value) => !value.equals(bytes))) {
      throw new ReplaySpoolError("maintenance_required");
    }
    transcriptByteSize += bytes.byteLength;
    if (transcriptByteSize > intent.limits.transcriptBytes) {
      throw new ReplaySpoolError("maintenance_required");
    }
    const previousChunkDigest = transcriptChunks.at(-1)?.chunkDigest ?? null;
    const contentDigest = createHash("sha256").update(bytes).digest("hex");
    const base = {
      ordinal,
      previousChunkDigest,
      contentDigest,
      byteSize: bytes.byteLength,
      cumulativeByteSize: transcriptByteSize
    };
    transcriptChunks.push(
      Object.freeze({
        ...base,
        chunkDigest: digestSpoolValue("autostack.transcript-chunk", base),
        bytes: Buffer.from(bytes)
      })
    );
  }
  return Object.freeze({
    events: Object.freeze(frames),
    eventByteSize,
    transcriptChunks: Object.freeze(transcriptChunks),
    transcriptByteSize,
    ...(cancel === undefined ? {} : { cancel }),
    ...(ack === undefined ? {} : { cancelAck: ack })
  });
};

export const inspectCommandPublications = async (
  paths: DataPathPolicy,
  commandRoot: string,
  expectedCommandId: string
): Promise<RecoveredCommandSpool> => {
  const receipts = await inspectReceiptHistory(paths, commandRoot, expectedCommandId);
  if (receipts === undefined) throw new ReplaySpoolError("maintenance_required");
  const spool = await inspectSpoolHistory(paths, commandRoot, receipts.intent);
  return Object.freeze({ ...receipts, ...spool });
};

const readTemporary = async (
  paths: DataPathPolicy,
  relativePath: string,
  maximumBytes: number
): Promise<Buffer> => {
  return await readBoundedInspection(paths, relativePath, maximumBytes, true);
};

const canonicalJsonMatches = <Value>(
  bytes: Buffer,
  parse: (candidate: unknown) => Value
): boolean => {
  try {
    const parsed = parse(JSON.parse(bytes.toString("utf8")));
    return bytes.equals(Buffer.from(canonicalJson(parsed), "utf8"));
  } catch {
    return false;
  }
};

const healDirectory = async (
  paths: DataPathPolicy,
  directory: string,
  accepts: (canonicalName: string) => boolean,
  validates: ByteValidator,
  maximumBytes: number,
  maximumEntries: number,
  maximumAggregateBytes: number,
  mutationGuard?: MutationGuard
): Promise<void> => {
  const admitted: Array<
    Readonly<{ readonly name: string; readonly canonicalName: string; readonly bytes: Buffer }>
  > = [];
  let aggregateBytes = 0;
  for (const entry of await inspectExistingDirectory(paths, directory, maximumEntries)) {
    if (entry.type !== "file") throw new ReplaySpoolError("maintenance_required");
    const match = TEMPORARY_NAME_PATTERN.exec(entry.name);
    const canonicalName = match?.[1] ?? entry.name;
    if (canonicalName === undefined || !accepts(canonicalName)) {
      throw new ReplaySpoolError("maintenance_required");
    }
    const bytes = await readTemporary(paths, `${directory}/${entry.name}`, maximumBytes);
    aggregateBytes += bytes.byteLength;
    if (aggregateBytes > maximumAggregateBytes) {
      throw new ReplaySpoolError("maintenance_required");
    }
    admitted.push(Object.freeze({ name: entry.name, canonicalName, bytes }));
  }
  const logical = new Map<string, Buffer>();
  for (const candidate of admitted) {
    const temporary = TEMPORARY_NAME_PATTERN.test(candidate.name);
    if (temporary && candidate.bytes.byteLength === 0) continue;
    if (!validates(candidate.canonicalName, candidate.bytes)) {
      throw new ReplaySpoolError("maintenance_required");
    }
    const prior = logical.get(candidate.canonicalName);
    if (prior !== undefined && !prior.equals(candidate.bytes)) {
      throw new ReplaySpoolError("maintenance_required");
    }
    logical.set(candidate.canonicalName, candidate.bytes);
  }
  for (const candidate of admitted) {
    const match = TEMPORARY_NAME_PATTERN.exec(candidate.name);
    if (match === null) continue;
    const { canonicalName } = candidate;
    const temporary = `${directory}/${candidate.name}`;
    const canonical = `${directory}/${canonicalName}`;
    mutationGuard?.();
    if (await paths.healLinkedAlias(temporary, canonical, undefined, false)) continue;

    const temporaryBytes = candidate.bytes;
    const canonicalExists = await paths.fileExists(canonical, false);
    if (temporaryBytes.byteLength === 0) {
      mutationGuard?.();
      if (!(await paths.unlinkFile(temporary, false))) {
        throw new ReplaySpoolError("unsafe_state");
      }
      mutationGuard?.();
      await paths.syncDirectory(directory, false);
      continue;
    }
    if (!validates(canonicalName, temporaryBytes)) {
      throw new ReplaySpoolError("maintenance_required");
    }
    if (canonicalExists) {
      const canonicalBytes = await readTemporary(paths, canonical, maximumBytes);
      if (!canonicalBytes.equals(temporaryBytes)) {
        throw new ReplaySpoolError("maintenance_required");
      }
      mutationGuard?.();
      if (!(await paths.unlinkFile(temporary, false))) {
        throw new ReplaySpoolError("unsafe_state");
      }
      mutationGuard?.();
      await paths.syncDirectory(directory, false);
      continue;
    }
    mutationGuard?.();
    if (!(await paths.linkFileNoReplace(temporary, canonical, false))) {
      throw new ReplaySpoolError("unsafe_state");
    }
    mutationGuard?.();
    await paths.syncDirectory(directory, false);
    mutationGuard?.();
    if (!(await paths.healLinkedAlias(temporary, canonical, undefined, false))) {
      throw new ReplaySpoolError("unsafe_state");
    }
    mutationGuard?.();
    await paths.syncDirectory(directory, false);
  }
};

export const healReceiptPublications = async (
  paths: DataPathPolicy,
  commandRoot: string,
  expectedCommandId?: string,
  expectedIntentDigest?: string,
  mutationGuard?: MutationGuard
): Promise<void> => {
  await inspectReceiptHistory(paths, commandRoot, expectedCommandId, expectedIntentDigest, true);
  await healDirectory(
    paths,
    `${commandRoot}/receipt`,
    (name) => RECEIPT_NAMES.includes(name as never),
    (name, bytes) => {
      const index = RECEIPT_NAMES.indexOf(name as never);
      return index === 0
        ? canonicalJsonMatches(bytes, parseIntentReceipt)
        : index > 0 && canonicalJsonMatches(bytes, parsePhaseReceipt);
    },
    MAXIMUM_INTENT_BYTES,
    RECEIPT_NAMES.length * 2,
    MAXIMUM_INTENT_BYTES * RECEIPT_NAMES.length * 2,
    mutationGuard
  );
};

export const healSpoolPublications = async (
  paths: DataPathPolicy,
  commandRoot: string,
  intent: CommandIntentReceipt,
  mutationGuard?: MutationGuard
): Promise<void> => {
  await inspectSpoolHistory(paths, commandRoot, intent);
  await healDirectory(
    paths,
    `${commandRoot}/control`,
    (name) => name === "cancel.json" || name === "cancel-ack.json",
    (name, bytes) =>
      name === "cancel.json"
        ? canonicalJsonMatches(bytes, parseCancelClaim)
        : canonicalJsonMatches(bytes, parseCancelAck),
    MAXIMUM_INTENT_BYTES,
    4,
    MAXIMUM_INTENT_BYTES * 4,
    mutationGuard
  );
  await healDirectory(
    paths,
    `${commandRoot}/spool/events`,
    (name) => EVENT_NAME_PATTERN.test(name),
    (name, bytes) => {
      if (bytes.byteLength > Math.min(MAXIMUM_EVENT_BYTES, intent.limits.eventBytes)) return false;
      try {
        const frame = parseFrame(JSON.parse(bytes.toString("utf8")));
        return (
          sequenceName(frame.sequence) === name &&
          bytes.equals(Buffer.from(canonicalJson(frame), "utf8"))
        );
      } catch {
        return false;
      }
    },
    Math.min(MAXIMUM_EVENT_BYTES, intent.limits.eventBytes),
    MAXIMUM_EVENTS * 2,
    intent.limits.replayBytes * 2,
    mutationGuard
  );
  const directory = `${commandRoot}/spool/transcript`;
  const maximumBytes = Math.min(1_048_576, intent.limits.transcriptBytes);
  const transcriptEntries = await inspectExistingDirectory(
    paths,
    directory,
    MAXIMUM_TRANSCRIPT_CHUNKS * 2
  );
  let aggregateBytes = 0;
  const admittedTranscript: Array<Readonly<{ readonly name: string; readonly bytes: Buffer }>> = [];
  for (const entry of transcriptEntries) {
    if (entry.type !== "file") throw new ReplaySpoolError("maintenance_required");
    const bytes = await readTemporary(paths, `${directory}/${entry.name}`, maximumBytes);
    aggregateBytes += bytes.byteLength;
    if (aggregateBytes > intent.limits.transcriptBytes * 2) {
      throw new ReplaySpoolError("maintenance_required");
    }
    admittedTranscript.push(Object.freeze({ name: entry.name, bytes }));
  }
  const transcriptLogical = new Map<string, Buffer>();
  for (const entry of admittedTranscript) {
    const temporary = entry.name.startsWith(".");
    const identified = temporary ? TRANSCRIPT_TEMPORARY_NAME_PATTERN.exec(entry.name) : null;
    const legacy = temporary ? TEMPORARY_NAME_PATTERN.exec(entry.name) : null;
    const canonicalName = identified?.[1] ?? legacy?.[1] ?? entry.name;
    if (canonicalName === undefined || !TRANSCRIPT_NAME_PATTERN.test(canonicalName)) {
      throw new ReplaySpoolError("maintenance_required");
    }
    if (temporary && entry.bytes.byteLength === 0) continue;
    if (
      entry.bytes.byteLength === 0 ||
      (temporary &&
        (identified === null ||
          identified[2] !== createHash("sha256").update(entry.bytes).digest("hex") ||
          Number(identified[3]) !== entry.bytes.byteLength))
    ) {
      throw new ReplaySpoolError("maintenance_required");
    }
    const prior = transcriptLogical.get(canonicalName);
    if (prior !== undefined && !prior.equals(entry.bytes)) {
      throw new ReplaySpoolError("maintenance_required");
    }
    transcriptLogical.set(canonicalName, entry.bytes);
  }
  for (const entry of admittedTranscript) {
    if (!entry.name.startsWith(".")) continue;
    const legacy = TEMPORARY_NAME_PATTERN.exec(entry.name);
    const identified = TRANSCRIPT_TEMPORARY_NAME_PATTERN.exec(entry.name);
    const canonicalName = identified?.[1] ?? legacy?.[1];
    if (canonicalName === undefined || !TRANSCRIPT_NAME_PATTERN.test(canonicalName)) {
      throw new ReplaySpoolError("maintenance_required");
    }
    const temporary = `${directory}/${entry.name}`;
    const canonical = `${directory}/${canonicalName}`;
    mutationGuard?.();
    if (await paths.healLinkedAlias(temporary, canonical, undefined, false)) continue;
    const { bytes } = entry;
    if (bytes.byteLength === 0) {
      mutationGuard?.();
      if (!(await paths.unlinkFile(temporary, false))) {
        throw new ReplaySpoolError("unsafe_state");
      }
      mutationGuard?.();
      await paths.syncDirectory(directory, false);
      continue;
    }
    if (identified === null) throw new ReplaySpoolError("maintenance_required");
    const expectedDigest = identified[2];
    const expectedSize = Number(identified[3]);
    if (
      expectedDigest === undefined ||
      !Number.isSafeInteger(expectedSize) ||
      expectedSize !== bytes.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== expectedDigest
    ) {
      throw new ReplaySpoolError("maintenance_required");
    }
    if (await paths.fileExists(canonical, false)) {
      const existing = await readTemporary(paths, canonical, maximumBytes);
      if (!existing.equals(bytes)) throw new ReplaySpoolError("maintenance_required");
      mutationGuard?.();
      if (!(await paths.unlinkFile(temporary, false))) {
        throw new ReplaySpoolError("unsafe_state");
      }
      mutationGuard?.();
      await paths.syncDirectory(directory, false);
      continue;
    }
    mutationGuard?.();
    if (!(await paths.linkFileNoReplace(temporary, canonical, false))) {
      throw new ReplaySpoolError("unsafe_state");
    }
    mutationGuard?.();
    await paths.syncDirectory(directory, false);
    mutationGuard?.();
    if (!(await paths.healLinkedAlias(temporary, canonical, undefined, false))) {
      throw new ReplaySpoolError("unsafe_state");
    }
    mutationGuard?.();
    await paths.syncDirectory(directory, false);
  }
};

export const healCommandPublications = async (
  paths: DataPathPolicy,
  commandRoot: string,
  commandId: string,
  mutationGuard?: MutationGuard
): Promise<void> => {
  const commandEntries = await inspectExistingDirectory(paths, commandRoot, 5);
  const allowed = new Map<string, "directory" | "file">([
    ["receipt", "directory"],
    ["control", "directory"],
    ["spool", "directory"],
    ["guardian-lease.sqlite3", "file"],
    ["guardian-lease.sqlite3-journal", "file"]
  ]);
  if (
    commandEntries.some((entry) => allowed.get(entry.name) !== entry.type) ||
    ["receipt", "control", "spool"].some(
      (name) => !commandEntries.some((entry) => entry.name === name && entry.type === "directory")
    )
  ) {
    throw new ReplaySpoolError("maintenance_required");
  }
  const spoolEntries = await inspectExistingDirectory(paths, `${commandRoot}/spool`, 2);
  if (
    spoolEntries.length !== 2 ||
    !["events", "transcript"].every((name) =>
      spoolEntries.some((entry) => entry.name === name && entry.type === "directory")
    )
  ) {
    throw new ReplaySpoolError("maintenance_required");
  }
  await healReceiptPublications(paths, commandRoot, commandId, undefined, mutationGuard);
  const intent = await parseCanonicalFile(
    paths,
    `${commandRoot}/receipt/01-intent.json`,
    MAXIMUM_INTENT_BYTES,
    parseIntentReceipt
  );
  await healSpoolPublications(paths, commandRoot, intent, mutationGuard);
};
