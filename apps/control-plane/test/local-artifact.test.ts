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

describe("LocalArtifactService verification refusals", () => {
  const respond = (
    body: (request: ReturnType<typeof ReadArtifactChunkRequestSchema.parse>) => unknown
  ) =>
    new LocalArtifactService({
      readArtifactRange: async (candidate) =>
        body(ReadArtifactChunkRequestSchema.parse(candidate)) as never
    });

  it("rejects a negative artifact size ceiling at construction", () => {
    expect(
      () => new LocalArtifactService({ readArtifactRange: async () => ({}) as never }, -1)
    ).toThrow(/Artifact size limit is invalid/);
  });

  it("refuses an artifact larger than the configured ceiling before reading any bytes", async () => {
    let reads = 0;
    const service = new LocalArtifactService(
      {
        readArtifactRange: async () => {
          reads += 1;
          return {} as never;
        }
      },
      bytes.byteLength - 1
    );

    await expect(service.verifyFinalizedArtifact(descriptor, ownership)).rejects.toThrow(
      /artifact verification/i
    );
    expect(reads).toBe(0);
  });

  it("refuses a descriptor candidate that is not a valid artifact descriptor", async () => {
    const service = respond(() => ({}));

    await expect(
      service.verifyFinalizedArtifact({ artifactId: "not-an-artifact" }, ownership)
    ).rejects.toThrow(/artifact verification/i);
  });

  // These two responses are deliberately NOT run through ReadArtifactChunkResponseSchema in the
  // fake host: the point is that the service refuses them itself, rather than the test fixture
  // refusing to build them.
  it("refuses a host chunk that claims no progress so a read can never stall", async () => {
    const service = respond((request) => ({
      artifact: descriptor,
      offset: request.offset,
      bytes: "",
      nextOffset: request.offset,
      done: false
    }));

    await expect(service.verifyFinalizedArtifact(descriptor, ownership)).rejects.toThrow(
      /artifact verification/i
    );
  });

  it("refuses a host chunk that declares completion short of the descriptor byte size", async () => {
    const truncated = bytes.subarray(0, 4);
    const service = respond((request) => ({
      artifact: descriptor,
      offset: request.offset,
      bytes: truncated.toString("base64"),
      nextOffset: truncated.byteLength,
      done: true
    }));

    await expect(service.verifyFinalizedArtifact(descriptor, ownership)).rejects.toThrow(
      /artifact verification/i
    );
  });

  it("propagates a transport failure as a verification failure rather than a raw error", async () => {
    const service = new LocalArtifactService({
      readArtifactRange: async () => {
        throw new Error("private transport failure");
      }
    });

    await expect(service.verifyFinalizedArtifact(descriptor, ownership)).rejects.toThrow(
      /artifact verification/i
    );
  });

  it("verifies a non-transcript artifact without scanning it for sensitive material", async () => {
    const output = Buffer.from("Bearer 0123456789abcdef0123456789abcdef", "utf8");
    const outputDescriptor = ArtifactDescriptorSchema.parse({
      ...descriptor,
      artifactId: "art_123e4567-e89b-42d3-a456-426614174001",
      kind: "command_output",
      mediaType: "application/octet-stream",
      digest: createHash("sha256").update(output).digest("hex"),
      byteSize: output.byteLength
    });
    const service = respond((request) =>
      ReadArtifactChunkResponseSchema.parse({
        artifact: outputDescriptor,
        offset: request.offset,
        bytes: output.toString("base64"),
        nextOffset: output.byteLength,
        done: true
      })
    );

    await expect(service.verifyFinalizedArtifact(outputDescriptor, ownership)).resolves.toEqual(
      outputDescriptor
    );
  });

  it("refuses a text transcript whose bytes contain sensitive material", async () => {
    const leaking = Buffer.from(
      "AKIAIOSFODNN7EXAMPLE aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n",
      "utf8"
    );
    const leakingDescriptor = ArtifactDescriptorSchema.parse({
      ...descriptor,
      artifactId: "art_123e4567-e89b-42d3-a456-426614174002",
      digest: createHash("sha256").update(leaking).digest("hex"),
      byteSize: leaking.byteLength
    });
    const service = respond((request) =>
      ReadArtifactChunkResponseSchema.parse({
        artifact: leakingDescriptor,
        offset: request.offset,
        bytes: leaking.toString("base64"),
        nextOffset: leaking.byteLength,
        done: true
      })
    );

    await expect(service.verifyFinalizedArtifact(leakingDescriptor, ownership)).rejects.toThrow(
      /artifact verification/i
    );
  });
});
