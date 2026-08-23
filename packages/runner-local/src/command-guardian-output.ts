import type { ArtifactDescriptor } from "@autostack/contracts";

import type { ArtifactStore } from "./artifact-store.js";
import type { ReplaySpool } from "./replay-spool.js";

export const EVENT_WRAPPER_RESERVE_BYTES = 4_096;
export const TERMINAL_REPLAY_RESERVE_BYTES = 16_384;
export const MAXIMUM_QUEUED_RAW_BYTES = 256 * 1_024;
export const MAXIMUM_QUEUED_RAW_FRAMES = 64;
export const MAXIMUM_TRANSCRIPT_SEGMENT_BYTES = 1_048_576;

export const splitEventText = (value: string, maximumBytes: number): readonly string[] => {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new TypeError();
  const chunks: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (characterBytes > maximumBytes) throw new TypeError();
    if (chunkBytes + characterBytes > maximumBytes) {
      if (chunk.length === 0) throw new TypeError();
      chunks.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += characterBytes;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
};

export const appendTranscriptSegments = async (
  spool: ReplaySpool,
  bytes: Uint8Array
): Promise<void> => {
  for (let offset = 0; offset < bytes.byteLength; offset += MAXIMUM_TRANSCRIPT_SEGMENT_BYTES) {
    await spool.appendTranscriptChunk(
      bytes.subarray(offset, Math.min(bytes.byteLength, offset + MAXIMUM_TRANSCRIPT_SEGMENT_BYTES))
    );
  }
};

export const publishTranscriptArtifact = async (options: {
  readonly artifactStore: ArtifactStore;
  readonly spool: ReplaySpool;
  readonly chunks: readonly Buffer[];
  readonly sensitiveValues: readonly string[];
}): Promise<ArtifactDescriptor> => {
  const immutableChunks = options.chunks.map((chunk) => Buffer.from(chunk));
  return await options.artifactStore.writeArtifact({
    metadata: {
      artifactId: options.spool.intent.transcriptArtifactId,
      workspaceId: options.spool.intent.workspaceId,
      runId: options.spool.intent.runId,
      commandId: options.spool.intent.commandId,
      kind: "command_transcript",
      mediaType: "text/plain; charset=utf-8",
      createdAt: options.spool.intent.artifactCreatedAt
    },
    content: (async function* () {
      for (const chunk of immutableChunks) yield Uint8Array.from(chunk);
    })(),
    maximumBytes: options.spool.intent.limits.transcriptBytes,
    sensitiveValues: options.sensitiveValues
  });
};
