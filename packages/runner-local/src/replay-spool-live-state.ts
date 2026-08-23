import type { DataPathPolicy } from "./path-policy.js";
import {
  MAXIMUM_EVENTS,
  MAXIMUM_EVENT_BYTES,
  canonicalJson,
  parseCanonicalFile,
  parseFrame,
  sequenceName
} from "./replay-spool-codec.js";
import { ReplaySpoolError } from "./replay-spool-error.js";
import type {
  CommandIntentReceipt,
  DurableRunnerFrame,
  RecoveredCommandSpool,
  TranscriptChunkEvidence
} from "./replay-spool-types.js";

export interface LiveSpoolState {
  readonly events: DurableRunnerFrame[];
  eventByteSize: number;
  terminal: boolean;
  transcriptOrdinal: number;
  transcriptByteSize: number;
  transcriptHeadDigest: string | null;
  transcriptClosed: boolean;
}

const liveStates = new WeakMap<object, LiveSpoolState>();

const terminalFrame = (frame: DurableRunnerFrame): boolean =>
  frame.event.type === "command.completed" || frame.event.type === "stream.error";

export const install = (owner: object, recovered: RecoveredCommandSpool): void => {
  liveStates.set(owner, {
    events: [...recovered.events],
    eventByteSize: recovered.eventByteSize,
    terminal: recovered.events.some(terminalFrame),
    transcriptOrdinal: recovered.transcriptChunks.length,
    transcriptByteSize: recovered.transcriptByteSize,
    transcriptHeadDigest: recovered.transcriptChunks.at(-1)?.chunkDigest ?? null,
    transcriptClosed: recovered.phases.some(
      (phase) => phase.phase === "finalizing" || phase.phase === "terminal"
    )
  });
};

export const requireState = (owner: object): LiveSpoolState => {
  const state = liveStates.get(owner);
  if (state === undefined) throw new ReplaySpoolError("maintenance_required");
  return state;
};

export const commitEvent = (
  owner: object,
  frame: DurableRunnerFrame,
  encodedBytes: number
): void => {
  const state = requireState(owner);
  if (
    state.terminal ||
    frame.sequence !== state.events.length + 1 ||
    frame.previousFrameDigest !== (state.events.at(-1)?.frameDigest ?? null)
  ) {
    throw new ReplaySpoolError("maintenance_required");
  }
  state.events.push(frame);
  state.eventByteSize += encodedBytes;
  state.terminal = terminalFrame(frame);
};

export const commitTranscript = (owner: object, evidence: TranscriptChunkEvidence): void => {
  const state = requireState(owner);
  if (
    state.transcriptClosed ||
    evidence.ordinal !== state.transcriptOrdinal + 1 ||
    evidence.previousChunkDigest !== state.transcriptHeadDigest ||
    evidence.cumulativeByteSize !== state.transcriptByteSize + evidence.byteSize
  ) {
    throw new ReplaySpoolError("maintenance_required");
  }
  state.transcriptOrdinal = evidence.ordinal;
  state.transcriptByteSize = evidence.cumulativeByteSize;
  state.transcriptHeadDigest = evidence.chunkDigest;
};

export const closeTranscript = (owner: object): void => {
  requireState(owner).transcriptClosed = true;
};

export const readEvent = async (
  owner: object,
  paths: DataPathPolicy,
  commandRoot: string,
  intent: CommandIntentReceipt,
  sequence: number
): Promise<DurableRunnerFrame | undefined> => {
  const state = requireState(owner);
  if (sequence <= state.events.length) return state.events[sequence - 1];
  if (sequence !== state.events.length + 1 || sequence > MAXIMUM_EVENTS || state.terminal) {
    return undefined;
  }
  const relativePath = `${commandRoot}/spool/events/${sequenceName(sequence)}`;
  if (!(await paths.fileExists(relativePath, false))) return undefined;
  const frame = await parseCanonicalFile(
    paths,
    relativePath,
    Math.min(MAXIMUM_EVENT_BYTES, intent.limits.eventBytes),
    parseFrame
  );
  const encodedBytes = Buffer.byteLength(canonicalJson(frame));
  if (
    frame.commandId !== intent.commandId ||
    frame.sequence !== sequence ||
    frame.previousFrameDigest !== (state.events.at(-1)?.frameDigest ?? null) ||
    (sequence === 1 && frame.event.type !== "command.started") ||
    state.eventByteSize + encodedBytes > intent.limits.replayBytes
  ) {
    throw new ReplaySpoolError("maintenance_required");
  }
  commitEvent(owner, frame, encodedBytes);
  return frame;
};

export const catchUpHead = async (
  owner: object,
  paths: DataPathPolicy,
  commandRoot: string,
  intent: CommandIntentReceipt
): Promise<number> => {
  for (;;) {
    const state = requireState(owner);
    if (
      state.terminal ||
      (await readEvent(owner, paths, commandRoot, intent, state.events.length + 1)) === undefined
    ) {
      return state.events.length;
    }
  }
};
