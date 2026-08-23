import { createHash, randomBytes } from "node:crypto";
import {
  CommandIdSchema,
  RunnerStreamEventSchema,
  normalizeSafeJson,
  type CommandId,
  type RunnerStreamEvent,
  type SafeJsonValue
} from "@autostack/contracts";
import { KeyedLock } from "./keyed-lock.js";
import { snapshotBytes } from "./command-guardian-bounds.js";
import {
  assertCommandGuardianLeaseFilesystemIdentity,
  assertLiveCommandGuardianLease,
  type CommandGuardianLease
} from "./data-root-lock.js";
import { snapshotRecoveryOpenOptions } from "./command-recovery-options.js";
import { DataPathPolicy } from "./path-policy.js";
import {
  EVENT_NAME_PATTERN,
  MAXIMUM_EVENTS,
  MAXIMUM_EVENT_BYTES,
  MAXIMUM_INTENT_BYTES,
  MAXIMUM_TRANSCRIPT_CHUNKS,
  TRANSCRIPT_NAME_PATTERN,
  admitCancelAckInput,
  admitIntent,
  canonicalJson,
  commandComponent,
  createCancelClaim,
  createCancelAck,
  createFrame,
  createIntentReceipt,
  createPhaseReceipt,
  digestSpoolValue,
  isTimestamp,
  parseCancelClaim,
  parseCancelAck,
  parseCanonicalFile,
  parseFrame,
  parseIntentReceipt,
  parsePhaseReceipt,
  readBounded,
  readBoundedInspection,
  sequenceName
} from "./replay-spool-codec.js";
import { publishImmutable } from "./replay-spool-immutable-publication.js";
import { prepareReplaySpoolOpen } from "./replay-spool-open.js";
import { isReplaySpoolError, ReplaySpoolError } from "./replay-spool-error.js";
import { brandRecoverySpool } from "./replay-spool-recovery-authority.js";
import * as live from "./replay-spool-live-state.js";
import {
  liveCanonicalEntries,
  requireExistingDirectoryEntries,
  validateLiveCommandLayout
} from "./replay-spool-live-inspection.js";
import {
  healCommandPublications,
  healReceiptPublications,
  healSpoolPublications
} from "./replay-spool-publication-recovery.js";
import { publishTranscriptImmutable } from "./replay-spool-transcript-publication.js";
import {
  RECEIPT_NAMES,
  RECEIPT_PHASES,
  type AdmittedCommandIntent,
  type CommandCancelDecision,
  type CommandCancelAck,
  type CommandIntentReceipt,
  type CommandPhaseReceipt,
  type CommandReceiptPhaseName,
  type DurableRunnerFrame,
  type RecordCommandCancelInput,
  type RecordCommandPhaseInput,
  type RecoveredCommandSpool,
  type RecoveredTranscriptChunk,
  type ReplaySpoolOpenOptions,
  type ReplaySpoolPublicationHook,
  type ReplaySpoolRegisterOptions,
  type ReplaySpoolRegistration,
  type TranscriptChunkEvidence
} from "./replay-spool-types.js";
export { ReplaySpoolError } from "./replay-spool-error.js";
export type * from "./replay-spool-types.js";
const publicationLock = new KeyedLock();
export class ReplaySpool {
  readonly #paths: DataPathPolicy;
  readonly #commandRoot: string;
  readonly #intent: CommandIntentReceipt;
  readonly #createAttemptId: () => string;
  readonly #publicationHook: ReplaySpoolPublicationHook | undefined;
  #recoveryGuard: (() => void) | undefined;
  private constructor(
    paths: DataPathPolicy,
    commandRoot: string,
    intent: CommandIntentReceipt,
    createAttemptId: () => string,
    publicationHook?: ReplaySpoolPublicationHook
  ) {
    this.#paths = paths;
    this.#commandRoot = commandRoot;
    this.#intent = intent;
    this.#createAttemptId = createAttemptId;
    this.#publicationHook = publicationHook;
  }
  static async register(options: ReplaySpoolRegisterOptions): Promise<ReplaySpoolRegistration> {
    let dataRoot: string;
    let admittedIntent: AdmittedCommandIntent;
    let createAttemptId: () => string;
    let publicationHook: ReplaySpoolPublicationHook | undefined;
    try {
      dataRoot = options.dataRoot;
      admittedIntent = admitIntent(options.intent);
      const source = options.createAttemptId ?? (() => randomBytes(16).toString("hex"));
      const hook = options.publicationHook;
      if (
        typeof dataRoot !== "string" ||
        typeof source !== "function" ||
        (hook !== undefined && typeof hook !== "function")
      ) {
        throw new TypeError();
      }
      createAttemptId = () => Reflect.apply(source, undefined, []) as string;
      publicationHook =
        hook === undefined
          ? undefined
          : (relativePath, stage) => Reflect.apply(hook, options, [relativePath, stage]);
    } catch (error) {
      if (isReplaySpoolError(error)) throw error;
      throw new ReplaySpoolError("invalid_input");
    }
    const receipt = createIntentReceipt(admittedIntent);
    const component = commandComponent(admittedIntent.commandId);
    const commandRoot = `commands/${component}`;
    const intentRelativePath = `${commandRoot}/receipt/01-intent.json`;
    try {
      return await publicationLock.run(`${dataRoot}:${component}`, async () => {
        const paths = await DataPathPolicy.create(dataRoot);
        for (const directory of [
          commandRoot,
          `${commandRoot}/receipt`,
          `${commandRoot}/control`,
          `${commandRoot}/spool`,
          `${commandRoot}/spool/events`,
          `${commandRoot}/spool/transcript`
        ]) {
          await paths.ensureDirectory(directory);
        }
        await healReceiptPublications(paths, commandRoot, admittedIntent.commandId);
        let replayed = false;
        if (await paths.fileExists(intentRelativePath)) {
          const existing = await parseCanonicalFile(
            paths,
            intentRelativePath,
            MAXIMUM_INTENT_BYTES,
            parseIntentReceipt
          );
          if (existing.receiptDigest !== receipt.receiptDigest) {
            throw new ReplaySpoolError("command_conflict");
          }
          replayed = true;
        } else {
          const bytes = Buffer.from(canonicalJson(receipt), "utf8");
          if (bytes.byteLength > MAXIMUM_INTENT_BYTES) {
            throw new ReplaySpoolError("invalid_input");
          }
          const outcome = await publishImmutable(
            paths,
            intentRelativePath,
            bytes,
            createAttemptId(),
            publicationHook
          );
          replayed = outcome === "existing";
        }
        const spool = new ReplaySpool(
          paths,
          commandRoot,
          receipt,
          createAttemptId,
          publicationHook
        );
        await healSpoolPublications(paths, commandRoot, receipt);
        live.install(spool, await spool.#recoverUnlocked());
        return Object.freeze({ spool, receipt, replayed, intentRelativePath });
      });
    } catch (error) {
      if (isReplaySpoolError(error)) throw error;
      throw new ReplaySpoolError("unsafe_state");
    }
  }
  static async open(options: ReplaySpoolOpenOptions): Promise<ReplaySpool> {
    const opened = await prepareReplaySpoolOpen(options);
    const spool = new ReplaySpool(
      opened.paths,
      opened.commandRoot,
      opened.receipt,
      opened.createAttemptId
    );
    await spool.recover();
    return spool;
  }
  static async openForRecovery(
    options: ReplaySpoolOpenOptions & Readonly<{ readonly lease: CommandGuardianLease }>
  ): Promise<ReplaySpool> {
    try {
      const admitted = snapshotRecoveryOpenOptions(options);
      const commandId = CommandIdSchema.parse(admitted.commandId);
      const commandRoot = `commands/${commandComponent(commandId)}`;
      assertLiveCommandGuardianLease(admitted.lease, admitted.dataRoot, commandId);
      const paths = await DataPathPolicy.openExisting(admitted.dataRoot);
      await assertCommandGuardianLeaseFilesystemIdentity(admitted.lease, paths, commandId);
      const guard = () => assertLiveCommandGuardianLease(admitted.lease, paths.root, commandId);
      guard();
      await healCommandPublications(paths, commandRoot, commandId, guard);
      const spool = await ReplaySpool.open(
        Object.freeze({
          dataRoot: admitted.dataRoot,
          commandId,
          ...(admitted.createAttemptId === undefined
            ? {}
            : { createAttemptId: admitted.createAttemptId })
        })
      );
      spool.#recoveryGuard = brandRecoverySpool(spool, paths.root, commandId, admitted.lease);
      return spool;
    } catch (error) {
      if (isReplaySpoolError(error)) throw error;
      throw new ReplaySpoolError("maintenance_required");
    }
  }
  get intent(): CommandIntentReceipt {
    return this.#intent;
  }
  async appendEvent(
    eventInput: RunnerStreamEvent,
    options: Readonly<{ reserveReplayBytes?: number }> = {}
  ): Promise<DurableRunnerFrame> {
    return publicationLock.run(`${this.#paths.root}:${this.#commandRoot}`, async () => {
      const state = live.requireState(this);
      if (state.events.length >= MAXIMUM_EVENTS) {
        throw new ReplaySpoolError("invalid_transition");
      }
      let event: RunnerStreamEvent;
      try {
        event = RunnerStreamEventSchema.parse(normalizeSafeJson(eventInput));
      } catch {
        throw new ReplaySpoolError("invalid_input");
      }
      const expectedSequence = state.events.length + 1;
      if (event.commandId !== this.#intent.commandId || event.sequence !== expectedSequence) {
        throw new ReplaySpoolError("invalid_transition");
      }
      if (state.terminal || (expectedSequence === 1 && event.type !== "command.started")) {
        throw new ReplaySpoolError("invalid_transition");
      }
      const previousFrameDigest = state.events.at(-1)?.frameDigest ?? null;
      const frame = createFrame(this.#intent.commandId, event, previousFrameDigest);
      const bytes = Buffer.from(canonicalJson(frame), "utf8");
      if (bytes.byteLength > Math.min(MAXIMUM_EVENT_BYTES, this.#intent.limits.eventBytes)) {
        throw new ReplaySpoolError("invalid_input");
      }
      const reserveReplayBytes = options.reserveReplayBytes ?? 0;
      if (!Number.isSafeInteger(reserveReplayBytes) || reserveReplayBytes < 0) {
        throw new ReplaySpoolError("invalid_input");
      }
      if (
        state.eventByteSize + bytes.byteLength + reserveReplayBytes >
        this.#intent.limits.replayBytes
      ) {
        throw new ReplaySpoolError("invalid_transition");
      }
      this.#recoveryGuard?.();
      await publishImmutable(
        this.#paths,
        `${this.#commandRoot}/spool/events/${sequenceName(expectedSequence)}`,
        bytes,
        this.#createAttemptId(),
        this.#publicationHook,
        this.#recoveryGuard
      );
      live.commitEvent(this, frame, bytes.byteLength);
      return frame;
    });
  }
  async recordCancel(input: RecordCommandCancelInput): Promise<CommandCancelDecision> {
    return publicationLock.run(`${this.#paths.root}:${this.#commandRoot}`, async () => {
      const path = `${this.#commandRoot}/control/cancel.json`;
      const proposed = createCancelClaim(this.#intent.commandId, input);
      if (await this.#paths.fileExists(path, this.#recoveryGuard === undefined)) {
        const existing = await parseCanonicalFile(
          this.#paths,
          path,
          MAXIMUM_INTENT_BYTES,
          parseCancelClaim
        );
        if (existing.requestDigest !== proposed.requestDigest) {
          throw new ReplaySpoolError("command_conflict");
        }
        return Object.freeze({ ...existing, replayed: true });
      }
      const bytes = Buffer.from(canonicalJson(proposed), "utf8");
      this.#recoveryGuard?.();
      const outcome = await publishImmutable(
        this.#paths,
        path,
        bytes,
        this.#createAttemptId(),
        this.#publicationHook,
        this.#recoveryGuard
      );
      if (outcome === "existing") {
        const existing = await parseCanonicalFile(
          this.#paths,
          path,
          MAXIMUM_INTENT_BYTES,
          parseCancelClaim
        );
        if (existing.requestDigest !== proposed.requestDigest) {
          throw new ReplaySpoolError("command_conflict");
        }
        return Object.freeze({ ...existing, replayed: true });
      }
      return Object.freeze({ ...proposed, replayed: false });
    });
  }
  async recordCancelAck(input: {
    readonly claimDigest: string;
    readonly acknowledgedAt: string;
  }): Promise<CommandCancelAck> {
    return publicationLock.run(`${this.#paths.root}:${this.#commandRoot}`, async () => {
      const admitted = admitCancelAckInput(input);
      const recovered = await this.#recoverUnlocked();
      live.install(this, recovered);
      if (recovered.cancel === undefined || recovered.cancel.claimDigest !== admitted.claimDigest) {
        throw new ReplaySpoolError("invalid_transition");
      }
      const proposed = createCancelAck(
        this.#intent.commandId,
        admitted.claimDigest,
        admitted.acknowledgedAt
      );
      const path = `${this.#commandRoot}/control/cancel-ack.json`;
      if (recovered.cancelAck !== undefined) {
        if (recovered.cancelAck.claimDigest !== proposed.claimDigest) {
          throw new ReplaySpoolError("command_conflict");
        }
        return recovered.cancelAck;
      }
      this.#recoveryGuard?.();
      await publishImmutable(
        this.#paths,
        path,
        Buffer.from(canonicalJson(proposed), "utf8"),
        this.#createAttemptId(),
        this.#publicationHook,
        this.#recoveryGuard
      );
      return proposed;
    });
  }
  async recordPhase(
    phase: Exclude<CommandReceiptPhaseName, "intent">,
    input: RecordCommandPhaseInput
  ): Promise<CommandPhaseReceipt> {
    return publicationLock.run(`${this.#paths.root}:${this.#commandRoot}`, async () => {
      const recovered = await this.#recoverUnlocked();
      live.install(this, recovered);
      const expectedSequence = recovered.phases.length + 1;
      const expectedPhase = RECEIPT_PHASES[expectedSequence - 1];
      if (
        expectedPhase === undefined ||
        expectedPhase === "intent" ||
        phase !== expectedPhase ||
        expectedSequence < 2 ||
        expectedSequence > 6
      ) {
        throw new ReplaySpoolError("invalid_transition");
      }
      let recordedAt: string;
      let evidence: SafeJsonValue;
      try {
        recordedAt = input.recordedAt;
        evidence = normalizeSafeJson(input.evidence);
      } catch {
        throw new ReplaySpoolError("invalid_input");
      }
      if (!isTimestamp(recordedAt)) throw new ReplaySpoolError("invalid_input");
      const previous = recovered.phases.at(-1);
      if (
        previous === undefined ||
        Date.parse(recordedAt) <=
          Date.parse(previous.phase === "intent" ? previous.acceptedAt : previous.recordedAt)
      ) {
        throw new ReplaySpoolError("invalid_transition");
      }
      const receipt = createPhaseReceipt(
        phase,
        expectedSequence as 2 | 3 | 4 | 5 | 6,
        this.#intent.commandId,
        previous.receiptDigest,
        recordedAt,
        evidence
      );
      const bytes = Buffer.from(canonicalJson(receipt), "utf8");
      if (bytes.byteLength > MAXIMUM_INTENT_BYTES) throw new ReplaySpoolError("invalid_input");
      this.#recoveryGuard?.();
      await publishImmutable(
        this.#paths,
        `${this.#commandRoot}/receipt/${RECEIPT_NAMES[expectedSequence - 1]}`,
        bytes,
        this.#createAttemptId(),
        this.#publicationHook,
        this.#recoveryGuard
      );
      if (phase === "finalizing" || phase === "terminal") live.closeTranscript(this);
      return receipt;
    });
  }
  async appendTranscriptChunk(chunkInput: Uint8Array): Promise<TranscriptChunkEvidence> {
    return publicationLock.run(`${this.#paths.root}:${this.#commandRoot}`, async () => {
      let chunk: Uint8Array;
      try {
        chunk = snapshotBytes(chunkInput, { maximumBytes: 1_048_576 });
      } catch {
        throw new ReplaySpoolError("invalid_input");
      }
      if (chunk.byteLength < 1) {
        throw new ReplaySpoolError("invalid_input");
      }
      const state = live.requireState(this);
      if (state.transcriptClosed) {
        throw new ReplaySpoolError("invalid_transition");
      }
      const ordinal = state.transcriptOrdinal + 1;
      if (ordinal > MAXIMUM_TRANSCRIPT_CHUNKS) {
        throw new ReplaySpoolError("invalid_transition");
      }
      const cumulativeByteSize = state.transcriptByteSize + chunk.byteLength;
      if (cumulativeByteSize > this.#intent.limits.transcriptBytes) {
        throw new ReplaySpoolError("invalid_transition");
      }
      const previousChunkDigest = state.transcriptHeadDigest;
      const contentDigest = createHash("sha256").update(chunk).digest("hex");
      const base = {
        ordinal,
        previousChunkDigest,
        contentDigest,
        byteSize: chunk.byteLength,
        cumulativeByteSize
      };
      const evidence = Object.freeze({
        ...base,
        chunkDigest: digestSpoolValue("autostack.transcript-chunk", base)
      });
      this.#recoveryGuard?.();
      await publishTranscriptImmutable({
        paths: this.#paths,
        canonicalRelativePath: `${this.#commandRoot}/spool/transcript/${String(ordinal).padStart(12, "0")}.bin`,
        bytes: chunk,
        evidence,
        attempt: this.#createAttemptId(),
        ...(this.#recoveryGuard === undefined ? {} : { mutationGuard: this.#recoveryGuard }),
        ...(this.#publicationHook === undefined ? {} : { publicationHook: this.#publicationHook })
      });
      live.commitTranscript(this, evidence);
      return evidence;
    });
  }
  async #recoverUnlocked(): Promise<RecoveredCommandSpool> {
    try {
      await validateLiveCommandLayout(this.#paths, this.#commandRoot);
      const receipt = await parseCanonicalFile(
        this.#paths,
        `${this.#commandRoot}/receipt/01-intent.json`,
        MAXIMUM_INTENT_BYTES,
        parseIntentReceipt
      );
      if (receipt.receiptDigest !== this.#intent.receiptDigest) {
        throw new ReplaySpoolError("maintenance_required");
      }
      const receiptEntries = liveCanonicalEntries(
        await requireExistingDirectoryEntries(
          this.#paths,
          `${this.#commandRoot}/receipt`,
          RECEIPT_NAMES.length * 2
        ),
        (name) => RECEIPT_NAMES.includes(name as never)
      );
      if (receiptEntries.length < 1 || receiptEntries.length > RECEIPT_NAMES.length) {
        throw new ReplaySpoolError("maintenance_required");
      }
      const receiptNames = receiptEntries.map((entry) => {
        if (entry.type !== "file" || !RECEIPT_NAMES.includes(entry.name as never)) {
          throw new ReplaySpoolError("maintenance_required");
        }
        return entry.name;
      });
      receiptNames.sort();
      const phases: (CommandIntentReceipt | CommandPhaseReceipt)[] = [receipt];
      for (let index = 0; index < receiptNames.length; index += 1) {
        const expectedName = RECEIPT_NAMES[index];
        if (expectedName === undefined || receiptNames[index] !== expectedName) {
          throw new ReplaySpoolError("maintenance_required");
        }
        if (index === 0) continue;
        const phase = await parseCanonicalFile(
          this.#paths,
          `${this.#commandRoot}/receipt/${expectedName}`,
          MAXIMUM_INTENT_BYTES,
          parsePhaseReceipt
        );
        const previous = phases.at(-1);
        if (
          previous === undefined ||
          phase.commandId !== receipt.commandId ||
          phase.sequence !== index + 1 ||
          phase.previousReceiptDigest !== previous.receiptDigest ||
          Date.parse(phase.recordedAt) <=
            Date.parse(previous.phase === "intent" ? previous.acceptedAt : previous.recordedAt)
        ) {
          throw new ReplaySpoolError("maintenance_required");
        }
        phases.push(phase);
      }
      const entries = liveCanonicalEntries(
        await requireExistingDirectoryEntries(
          this.#paths,
          `${this.#commandRoot}/spool/events`,
          MAXIMUM_EVENTS * 2
        ),
        (name) => EVENT_NAME_PATTERN.test(name)
      );
      if (entries.length > MAXIMUM_EVENTS) throw new ReplaySpoolError("maintenance_required");
      const eventNames = entries.map((entry) => {
        if (entry.type !== "file") throw new ReplaySpoolError("maintenance_required");
        const matched = EVENT_NAME_PATTERN.exec(entry.name);
        if (matched?.[1] === undefined) throw new ReplaySpoolError("maintenance_required");
        return { name: entry.name, sequence: Number(matched[1]) };
      });
      eventNames.sort((left, right) => left.sequence - right.sequence);
      const events: DurableRunnerFrame[] = [];
      let eventByteSize = 0;
      for (const [index, entry] of eventNames.entries()) {
        const sequence = index + 1;
        if (entry.sequence !== sequence || entry.name !== sequenceName(sequence)) {
          throw new ReplaySpoolError("maintenance_required");
        }
        const relativePath = `${this.#commandRoot}/spool/events/${entry.name}`;
        const frame = await parseCanonicalFile(
          this.#paths,
          relativePath,
          Math.min(MAXIMUM_EVENT_BYTES, this.#intent.limits.eventBytes),
          parseFrame
        );
        if (
          frame.commandId !== receipt.commandId ||
          frame.sequence !== sequence ||
          frame.previousFrameDigest !== (events.at(-1)?.frameDigest ?? null)
        ) {
          throw new ReplaySpoolError("maintenance_required");
        }
        const bytes = Buffer.byteLength(canonicalJson(frame));
        eventByteSize += bytes;
        if (eventByteSize > receipt.limits.replayBytes) {
          throw new ReplaySpoolError("maintenance_required");
        }
        events.push(frame);
      }
      const transcriptEntries = liveCanonicalEntries(
        await requireExistingDirectoryEntries(
          this.#paths,
          `${this.#commandRoot}/spool/transcript`,
          MAXIMUM_TRANSCRIPT_CHUNKS * 2
        ),
        (name) => TRANSCRIPT_NAME_PATTERN.test(name),
        true
      );
      if (transcriptEntries.length > MAXIMUM_TRANSCRIPT_CHUNKS) {
        throw new ReplaySpoolError("maintenance_required");
      }
      const transcriptNames = transcriptEntries.map((entry) => {
        if (entry.type !== "file") throw new ReplaySpoolError("maintenance_required");
        const matched = TRANSCRIPT_NAME_PATTERN.exec(entry.name);
        if (matched?.[1] === undefined) throw new ReplaySpoolError("maintenance_required");
        return { name: entry.name, ordinal: Number(matched[1]) };
      });
      transcriptNames.sort((left, right) => left.ordinal - right.ordinal);
      const transcriptChunks: RecoveredTranscriptChunk[] = [];
      let transcriptByteSize = 0;
      for (const [index, entry] of transcriptNames.entries()) {
        const ordinal = index + 1;
        const expectedName = `${String(ordinal).padStart(12, "0")}.bin`;
        if (entry.ordinal !== ordinal || entry.name !== expectedName) {
          throw new ReplaySpoolError("maintenance_required");
        }
        const bytes = await readBoundedInspection(
          this.#paths,
          `${this.#commandRoot}/spool/transcript/${entry.name}`,
          Math.min(1_048_576, receipt.limits.transcriptBytes)
        );
        transcriptByteSize += bytes.byteLength;
        if (transcriptByteSize > receipt.limits.transcriptBytes) {
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
      const controlEntries = liveCanonicalEntries(
        await requireExistingDirectoryEntries(this.#paths, `${this.#commandRoot}/control`, 4),
        (name) => name === "cancel.json" || name === "cancel-ack.json"
      );
      if (
        controlEntries.length > 2 ||
        controlEntries.some(
          (entry) =>
            entry.type !== "file" ||
            (entry.name !== "cancel.json" && entry.name !== "cancel-ack.json")
        ) ||
        (controlEntries.some((entry) => entry.name === "cancel-ack.json") &&
          !controlEntries.some((entry) => entry.name === "cancel.json"))
      ) {
        throw new ReplaySpoolError("maintenance_required");
      }
      const cancel = !controlEntries.some((entry) => entry.name === "cancel.json")
        ? undefined
        : await parseCanonicalFile(
            this.#paths,
            `${this.#commandRoot}/control/cancel.json`,
            MAXIMUM_INTENT_BYTES,
            parseCancelClaim
          );
      const cancelAck = !controlEntries.some((entry) => entry.name === "cancel-ack.json")
        ? undefined
        : await parseCanonicalFile(
            this.#paths,
            `${this.#commandRoot}/control/cancel-ack.json`,
            MAXIMUM_INTENT_BYTES,
            parseCancelAck
          );
      if (
        (cancel !== undefined && cancel.commandId !== receipt.commandId) ||
        (cancelAck !== undefined &&
          (cancel === undefined ||
            cancelAck.commandId !== receipt.commandId ||
            cancelAck.claimDigest !== cancel.claimDigest ||
            Date.parse(cancelAck.acknowledgedAt) < Date.parse(cancel.decidedAt)))
      ) {
        throw new ReplaySpoolError("maintenance_required");
      }
      return Object.freeze({
        intent: receipt,
        phases: Object.freeze(phases),
        events: Object.freeze(events),
        eventByteSize,
        transcriptChunks: Object.freeze(transcriptChunks),
        transcriptByteSize,
        ...(cancel === undefined ? {} : { cancel }),
        ...(cancelAck === undefined ? {} : { cancelAck })
      });
    } catch (error) {
      if (isReplaySpoolError(error)) throw error;
      throw new ReplaySpoolError("maintenance_required");
    }
  }
  async recover(): Promise<RecoveredCommandSpool> {
    return await publicationLock.run(`${this.#paths.root}:${this.#commandRoot}`, async () => {
      const recovered = await this.#recoverUnlocked();
      live.install(this, recovered);
      return recovered;
    });
  }
  async readEvent(sequence: number): Promise<DurableRunnerFrame | undefined> {
    if (!Number.isSafeInteger(sequence) || sequence < 1)
      throw new ReplaySpoolError("invalid_input");
    return await publicationLock.run(`${this.#paths.root}:${this.#commandRoot}`, async () =>
      live.readEvent(this, this.#paths, this.#commandRoot, this.#intent, sequence)
    );
  }
  async head(): Promise<number> {
    return await publicationLock.run(`${this.#paths.root}:${this.#commandRoot}`, async () =>
      live.catchUpHead(this, this.#paths, this.#commandRoot, this.#intent)
    );
  }
}
