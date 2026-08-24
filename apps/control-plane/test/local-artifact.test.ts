import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ArtifactDescriptorSchema,
  ReadArtifactChunkRequestSchema,
  ReadArtifactChunkResponseSchema
} from "@autostack/contracts";

import { LocalArtifactService } from "../src/local-artifact-service.js";

const bytes = Buffer.from("verified transcript", "utf8");
const descriptor = ArtifactDescriptorSchema.parse({
  artifactId: "art_123e4567-e89b-42d3-a456-426614174000",
  workspaceId: "ws_123e4567-e89b-42d3-a456-426614174000",
  runId: "run_123e4567-e89b-42d3-a456-426614174000",
  commandId: "cmd_123e4567-e89b-42d3-a456-426614174000",
  kind: "command_transcript",
  mediaType: "text/plain; charset=utf-8",
  digest: createHash("sha256").update(bytes).digest("hex"),
  byteSize: bytes.byteLength,
  createdAt: "2026-08-21T12:00:00.000Z"
});
const parsedOwnershipRequest = ReadArtifactChunkRequestSchema.parse({
  workspaceId: descriptor.workspaceId,
  runId: descriptor.runId,
  environmentId: "env_123e4567-e89b-42d3-a456-426614174000",
  commandId: descriptor.commandId,
  environmentAuthorizationId: "envauth_123e4567-e89b-42d3-a456-426614174000",
  environmentAuthorizationDigest: "a".repeat(64),
  commandAuthorizationId: "cmdauth_123e4567-e89b-42d3-a456-426614174000",
  commandAuthorizationDigest: "b".repeat(64),
  artifactId: descriptor.artifactId,
  offset: 0,
  length: 1
});
const {
  artifactId: _artifactId,
  offset: _offset,
  length: _length,
  ...ownership
} = parsedOwnershipRequest;

describe("LocalArtifactService", () => {
  it("verifies progressive bounded bytes before accepting the immutable descriptor", async () => {
    const lengths: number[] = [];
    const service = new LocalArtifactService({
      readArtifactRange: async (candidate) => {
        const request = ReadArtifactChunkRequestSchema.parse(candidate);
        lengths.push(request.length);
        const chunk = bytes.subarray(
          request.offset,
          Math.min(request.offset + 8, bytes.byteLength)
        );
        return ReadArtifactChunkResponseSchema.parse({
          artifact: descriptor,
          offset: request.offset,
          bytes: chunk.toString("base64"),
          nextOffset: request.offset + chunk.byteLength,
          done: request.offset + chunk.byteLength === bytes.byteLength
        });
      }
    });

    await expect(service.verifyFinalizedArtifact(descriptor, ownership)).resolves.toEqual(
      descriptor
    );
    expect(lengths.every((length) => length <= 1_048_576)).toBe(true);
    expect(Object.isFrozen(await service.verifyFinalizedArtifact(descriptor, ownership))).toBe(
      true
    );
  });

  it("rejects descriptor drift and digest mismatch", async () => {
    const drifted = { ...descriptor, digest: "f".repeat(64) };
    const service = new LocalArtifactService({
      readArtifactRange: async (request) =>
        ReadArtifactChunkResponseSchema.parse({
          artifact: drifted,
          offset: request.offset,
          bytes: bytes.toString("base64"),
          nextOffset: bytes.byteLength,
          done: true
        })
    });

    await expect(service.verifyFinalizedArtifact(descriptor, ownership)).rejects.toThrow(
      /artifact verification/i
    );
  });
});
