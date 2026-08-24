import { createHash } from "node:crypto";

import {
  ArtifactDescriptorSchema,
  ReadArtifactChunkRequestSchema,
  StreamingSensitiveMaterialDetector,
  validateArtifactChunkResponse,
  type ArtifactDescriptor,
  type ReadArtifactChunkRequest,
  type ReadArtifactChunkResponse
} from "@autostack/contracts";

const MAXIMUM_RANGE_BYTES = 1_048_576;

export class ArtifactVerificationError extends Error {
  constructor() {
    super("Artifact verification failed.");
    this.name = "ArtifactVerificationError";
  }
}

type ArtifactOwnership = Omit<ReadArtifactChunkRequest, "artifactId" | "offset" | "length">;

export interface ArtifactRangeClient {
  readArtifactRange(request: ReadArtifactChunkRequest): Promise<ReadArtifactChunkResponse>;
}

const sameDescriptor = (left: ArtifactDescriptor, right: ArtifactDescriptor): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export class LocalArtifactService {
  readonly #client: ArtifactRangeClient;
  readonly #maximumArtifactBytes: number;

  constructor(client: ArtifactRangeClient, maximumArtifactBytes = 256 * 1024 * 1024) {
    if (!Number.isSafeInteger(maximumArtifactBytes) || maximumArtifactBytes < 0) {
      throw new TypeError("Artifact size limit is invalid.");
    }
    this.#client = client;
    this.#maximumArtifactBytes = maximumArtifactBytes;
  }

  async verifyFinalizedArtifact(
    expectedCandidate: unknown,
    ownership: ArtifactOwnership
  ): Promise<ArtifactDescriptor> {
    try {
      const expected = ArtifactDescriptorSchema.parse(structuredClone(expectedCandidate));
      if (expected.byteSize > this.#maximumArtifactBytes) throw new ArtifactVerificationError();
      const digest = createHash("sha256");
      const detector = new StreamingSensitiveMaterialDetector();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const scanTranscript =
        expected.kind === "command_transcript" && expected.mediaType.startsWith("text/");
      let offset = 0;
      do {
        const request = ReadArtifactChunkRequestSchema.parse({
          ...ownership,
          artifactId: expected.artifactId,
          offset,
          length: Math.max(1, Math.min(MAXIMUM_RANGE_BYTES, expected.byteSize - offset))
        });
        const response = validateArtifactChunkResponse(
          request,
          await this.#client.readArtifactRange(request)
        );
        if (!sameDescriptor(expected, response.artifact)) throw new ArtifactVerificationError();
        const chunk = Buffer.from(response.bytes, "base64");
        if (!response.done && chunk.byteLength === 0) throw new ArtifactVerificationError();
        digest.update(chunk);
        if (scanTranscript) detector.write(decoder.decode(chunk, { stream: !response.done }));
        offset = response.nextOffset;
        if (response.done) break;
      } while (offset < expected.byteSize);
      if (scanTranscript) {
        detector.write(decoder.decode());
        if (detector.finalize()) throw new ArtifactVerificationError();
      }
      if (offset !== expected.byteSize || digest.digest("hex") !== expected.digest) {
        throw new ArtifactVerificationError();
      }
      return Object.freeze(expected);
    } catch (error) {
      if (error instanceof ArtifactVerificationError) throw error;
      throw new ArtifactVerificationError();
    }
  }
}
