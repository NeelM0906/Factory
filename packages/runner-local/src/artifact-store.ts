import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { types as utilTypes } from "node:util";

import {
  ArtifactDescriptorSchema,
  ArtifactIdSchema,
  type ArtifactDescriptor,
  type ArtifactId
} from "@autostack/contracts";

import { ArtifactFiles } from "./artifact-files.js";
import {
  ARTIFACT_STREAM_BUFFER_BYTES,
  artifactHandlesHaveEqualBytes,
  inspectArtifactHandle,
  sameFileIdentity,
  snapshotFileIdentity,
  writeAll,
  type FileIdentitySnapshot
} from "./artifact-io.js";
import { ArtifactTransactions, type ArtifactAttempt } from "./artifact-transactions.js";
import {
  ArtifactStoreError,
  STATIC_ERROR_MESSAGES,
  descriptorForDigest,
  isArtifactStoreError,
  normalizeArtifactError,
  parseArtifactId,
  sameArtifactMetadata,
  snapshotArtifactMetadata,
  snapshotSensitiveValues,
  type AdmittedWriteArtifactRequest,
  type ArtifactReadResult,
  type ArtifactStoreOptions,
  type ArtifactWriteBoundary,
  type WriteArtifactRequest
} from "./artifact-types.js";
import { closeFileHandleAfterFailure, usingFileHandle } from "./file-handle-lifecycle.js";
import { KeyedLock } from "./keyed-lock.js";
import { DataPathPolicy } from "./path-policy.js";
import { StreamingSensitiveScanner, redactCompleteText } from "./redacted-transcript.js";

export {
  ARTIFACT_WRITE_BOUNDARIES,
  ArtifactStoreError,
  type ArtifactReadResult,
  type ArtifactStoreErrorCode,
  type ArtifactStoreOptions,
  type ArtifactWriteBoundary,
  type ArtifactWriteMetadata,
  type WriteArtifactRequest
} from "./artifact-types.js";

interface StreamedArtifact {
  readonly digest: string;
  readonly byteSize: number;
}

const MAX_METADATA_BYTES = 64 * 1_024;
const MAX_READ_BYTES = 1_048_576;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  "byteLength"
)?.get;

/** Immutable content-addressed evidence storage for AutoStack-owned operations. */
export class ArtifactStore {
  readonly #files: ArtifactFiles;
  readonly #transactions: ArtifactTransactions;
  readonly #onBoundary: ArtifactStoreOptions["onBoundary"];
  readonly #artifactLocks = new KeyedLock();
  readonly #digestLocks = new KeyedLock();

  private constructor(files: ArtifactFiles, onBoundary: ArtifactStoreOptions["onBoundary"]) {
    this.#files = files;
    this.#onBoundary = onBoundary;
    this.#transactions = new ArtifactTransactions(files, (boundary) => this.#boundary(boundary));
  }

  static async create(options: ArtifactStoreOptions): Promise<ArtifactStore> {
    let dataRoot: string;
    let onBoundary: ArtifactStoreOptions["onBoundary"];
    try {
      dataRoot = options.dataRoot;
      onBoundary = options.onBoundary;
    } catch {
      throw new ArtifactStoreError("filesystem_error", "Artifact-store options are unavailable.");
    }
    try {
      const paths = await DataPathPolicy.create(dataRoot);
      await paths.ensureDirectory("artifacts");
      await paths.ensureDirectory("artifacts/sha256");
      await paths.ensureDirectory("artifacts/metadata");
      await paths.ensureDirectory("artifacts/tmp");
      await paths.ensureDirectory("artifacts/transactions");
      const store = new ArtifactStore(new ArtifactFiles(paths), onBoundary);
      await store.#transactions.recover({
        verifyCommitted: async (artifactId, metadataHash) => {
          const record = await store.#readDescriptorRecord(artifactId);
          if (createHash("sha256").update(record.bytes).digest("hex") !== metadataHash) {
            throw new ArtifactStoreError(
              "integrity_mismatch",
              "Committed artifact metadata changed."
            );
          }
          await store.#verifyBlob(record.descriptor);
        }
      });
      return store;
    } catch (error) {
      throw normalizeArtifactError(error, "unsafe_state");
    }
  }

  async writeArtifact(request: WriteArtifactRequest): Promise<ArtifactDescriptor> {
    let admitted: AdmittedWriteArtifactRequest;
    try {
      const metadata = snapshotArtifactMetadata(request.metadata);
      admitted = {
        metadata,
        content: request.content,
        maximumBytes: request.maximumBytes,
        sensitiveValues: snapshotSensitiveValues(request.sensitiveValues)
      };
    } catch {
      throw new ArtifactStoreError("invalid_metadata", "The artifact request is unavailable.");
    }
    try {
      this.#assertWriteRequest(admitted);
      const artifactId = parseArtifactId(admitted.metadata.artifactId);
      return await this.#artifactLocks.run(artifactId, async () => {
        const existing = await this.#findArtifactInternal(artifactId);
        if (existing !== undefined) return await this.#compareExisting(existing, admitted);
        return await this.#writeNewArtifact(artifactId, admitted);
      });
    } catch (error) {
      throw normalizeArtifactError(error);
    }
  }

  async findArtifact(artifactIdInput: ArtifactId): Promise<ArtifactDescriptor | undefined> {
    try {
      return await this.#findArtifactInternal(parseArtifactId(artifactIdInput));
    } catch (error) {
      throw normalizeArtifactError(error, "unsafe_state");
    }
  }

  async readArtifact(
    artifactIdInput: ArtifactId,
    range: { readonly offset: number; readonly length: number }
  ): Promise<ArtifactReadResult> {
    let offset: number;
    let length: number;
    try {
      offset = range.offset;
      length = range.length;
    } catch {
      throw new ArtifactStoreError("invalid_read", STATIC_ERROR_MESSAGES.invalid_read);
    }
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > MAX_READ_BYTES ||
      offset > Number.MAX_SAFE_INTEGER - length
    ) {
      throw new ArtifactStoreError("invalid_read", STATIC_ERROR_MESSAGES.invalid_read);
    }
    try {
      const parsed = ArtifactIdSchema.safeParse(artifactIdInput);
      if (!parsed.success) throw new ArtifactStoreError("invalid_read", "Invalid artifact ID.");
      const descriptor = await this.#readCommittedDescriptor(parsed.data);
      if (descriptor === undefined || offset > descriptor.byteSize) {
        throw new ArtifactStoreError("invalid_read", "The artifact is unavailable.");
      }
      const bytes = await this.#verifyBlob(descriptor, [], { offset, length });
      const nextOffset = offset + bytes.byteLength;
      return {
        descriptor,
        offset,
        bytes,
        nextOffset,
        done: nextOffset >= descriptor.byteSize
      };
    } catch (error) {
      if (isArtifactStoreError(error) && error.code === "invalid_read") {
        throw normalizeArtifactError(error, "invalid_read");
      }
      throw normalizeArtifactError(error, "unsafe_state");
    }
  }

  async #writeNewArtifact(
    artifactId: ArtifactId,
    request: AdmittedWriteArtifactRequest
  ): Promise<ArtifactDescriptor> {
    let attempt: ArtifactAttempt | undefined;
    let descriptor: ArtifactDescriptor | undefined;
    try {
      attempt = await this.#transactions.begin(artifactId);
      const streamed = await this.#writeBlobTemp(attempt, request);
      descriptor = descriptorForDigest(request.metadata, streamed.digest, streamed.byteSize);
      return await this.#digestLocks.run(descriptor.digest, async () => {
        await this.#publishBlob(attempt!, descriptor!, request.sensitiveValues);
        const metadataBytes = await this.#publishMetadata(
          attempt!,
          descriptor!,
          request.sensitiveValues
        );
        await this.#transactions.commit(attempt!, descriptor!, metadataBytes);
        await this.#transactions.finish(attempt!);
        return descriptor!;
      });
    } catch (error) {
      try {
        if (attempt !== undefined) await this.#transactions.cleanupAttempt(attempt, descriptor);
      } catch {
        throw new ArtifactStoreError("unsafe_state", "Uncommitted artifact cleanup failed closed.");
      }
      throw error;
    }
  }

  async #writeBlobTemp(
    attempt: ArtifactAttempt,
    request: AdmittedWriteArtifactRequest
  ): Promise<StreamedArtifact> {
    const relativePath = this.#transactions.streamTempRelative(attempt);
    const handle = await this.#openCreatedFile(
      relativePath,
      "blob.file-opened",
      "blob.creation-parent-synced"
    );
    const digest = createHash("sha256");
    const scanner = new StreamingSensitiveScanner(request.sensitiveValues);
    let byteSize = 0;
    await usingFileHandle(handle, async () => {
      await this.#forEachContentChunk(request.content, request.maximumBytes, async (chunk) => {
        digest.update(chunk);
        scanner.write(chunk);
        byteSize = await writeAll(handle, chunk, byteSize);
      });
      await handle.sync();
    });
    await this.#boundary("blob.file-synced");
    await this.#files.syncDirectory("artifacts/tmp");
    await this.#boundary("blob.directory-synced");
    const digestHex = digest.digest("hex");
    const inspected = await this.#inspectRelativeFile(
      relativePath,
      request.sensitiveValues,
      byteSize
    );
    if (scanner.finalize() || inspected.sensitiveDetected) {
      throw new ArtifactStoreError("sensitive_artifact", "Credential material is forbidden.");
    }
    if (inspected.byteSize !== byteSize || inspected.digest !== digestHex) {
      throw new ArtifactStoreError("integrity_mismatch", "The artifact temp inode changed.");
    }
    return { digest: digestHex, byteSize };
  }

  async #publishBlob(
    attempt: ArtifactAttempt,
    descriptor: ArtifactDescriptor,
    sensitiveValues: readonly string[]
  ): Promise<void> {
    const blobRelative = this.#transactions.blobRelative(descriptor.digest);
    const publishTempRelative = this.#transactions.blobPublishTempRelative(
      attempt,
      descriptor.digest
    );
    const digestDirectory = `artifacts/sha256/${descriptor.digest.slice(0, 2)}`;
    await this.#files.refreshPublicationDirectory("artifacts/sha256");
    await this.#files.ensureDirectory(digestDirectory);
    await this.#boundary("blob.before-publish");
    await this.#files.refreshPublicationDirectory(digestDirectory);
    const destination = await this.#openCreatedFile(
      publishTempRelative,
      "transaction.publishing-file-opened",
      "transaction.publishing-creation-parent-synced"
    );
    await usingFileHandle(destination, async () => {
      const source = await this.#files.openRead(
        this.#transactions.streamTempRelative(attempt),
        "integrity_mismatch"
      );
      await usingFileHandle(source, async () => {
        const sourceBefore = snapshotFileIdentity(await source.stat());
        const digest = createHash("sha256");
        const scanner = new StreamingSensitiveScanner(sensitiveValues);
        const buffer = Buffer.alloc(ARTIFACT_STREAM_BUFFER_BYTES);
        let position = 0;
        for (;;) {
          const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, position);
          if (bytesRead === 0) break;
          const chunk = buffer.subarray(0, bytesRead);
          digest.update(chunk);
          scanner.write(chunk);
          await writeAll(destination, chunk, position);
          position += bytesRead;
        }
        if (
          !sameFileIdentity(sourceBefore, snapshotFileIdentity(await source.stat())) ||
          position !== descriptor.byteSize ||
          digest.digest("hex") !== descriptor.digest
        ) {
          throw new ArtifactStoreError("integrity_mismatch", "The artifact source inode changed.");
        }
        if (scanner.finalize()) {
          throw new ArtifactStoreError("sensitive_artifact", "Credential material is forbidden.");
        }
        await destination.sync();
      });
    });
    await this.#boundary("transaction.publishing-file-synced");
    await this.#files.syncDirectory(digestDirectory);
    await this.#boundary("transaction.publishing-directory-synced");
    const inspected = await this.#inspectRelativeFile(
      publishTempRelative,
      sensitiveValues,
      descriptor.byteSize
    );
    if (inspected.byteSize !== descriptor.byteSize || inspected.digest !== descriptor.digest) {
      throw new ArtifactStoreError("integrity_mismatch", "The publish temp inode changed.");
    }
    await this.#boundary("blob.final-file-opened");
    await this.#boundary("blob.final-creation-parent-synced");
    const linked = await this.#files.linkNoReplace(publishTempRelative, blobRelative);
    if (linked) {
      await this.#boundary("blob.canonical-linked");
      await this.#files.syncDirectory(digestDirectory);
      await this.#boundary("blob.canonical-directory-synced");
      const healed = await this.#files.healLinkedAlias(publishTempRelative, blobRelative, () =>
        this.#boundary("blob.publish-temp-unlinked")
      );
      if (!healed) {
        if (await this.#files.exists(publishTempRelative)) {
          throw new ArtifactStoreError("unsafe_state", "The blob publication alias changed.");
        }
        await this.#assertWinnerBytes(this.#transactions.streamTempRelative(attempt), blobRelative);
        await this.#boundary("blob.publish-temp-unlinked");
      }
      await this.#boundary("blob.publish-temp-unlink-directory-synced");
    } else {
      await this.#assertWinnerBytes(publishTempRelative, blobRelative);
      await this.#files.remove(publishTempRelative);
    }
    await this.#boundary("blob.final-file-synced");
    await this.#files.syncDirectory(digestDirectory);
    await this.#boundary("blob.final-directory-synced");
    await this.#boundary("blob.published");
    await this.#verifyBlob(descriptor, sensitiveValues);
    await this.#boundary("blob.verified");
    await this.#files.remove(this.#transactions.streamTempRelative(attempt));
  }

  async #publishMetadata(
    attempt: ArtifactAttempt,
    descriptor: ArtifactDescriptor,
    sensitiveValues: readonly string[]
  ): Promise<Buffer> {
    const metadataJson = `${JSON.stringify(descriptor)}\n`;
    const metadataBytes = Buffer.from(metadataJson);
    if (redactCompleteText(metadataJson, sensitiveValues).sensitiveDetected) {
      throw new ArtifactStoreError("invalid_metadata", "Artifact metadata is invalid or unsafe.");
    }
    await this.#boundary("metadata.before-publish");
    await this.#files.refreshPublicationDirectory("artifacts/metadata");
    const canonicalRelative = this.#transactions.metadataRelative(descriptor.artifactId);
    const tempRelative = this.#transactions.metadataTempRelative(attempt);
    const handle = await this.#openCreatedFile(
      tempRelative,
      "metadata.file-opened",
      "metadata.creation-parent-synced"
    );
    await usingFileHandle(handle, async () => {
      await writeAll(handle, metadataBytes, 0);
      await handle.sync();
    });
    await this.#boundary("metadata.file-synced");
    await this.#files.syncDirectory("artifacts/metadata");
    await this.#boundary("metadata.directory-synced");
    const linked = await this.#files.linkNoReplace(tempRelative, canonicalRelative);
    if (linked) {
      await this.#boundary("metadata.canonical-linked");
      await this.#files.syncDirectory("artifacts/metadata");
      await this.#boundary("metadata.canonical-directory-synced");
      const healed = await this.#files.healLinkedAlias(tempRelative, canonicalRelative, () =>
        this.#boundary("metadata.publish-temp-unlinked")
      );
      if (!healed) {
        if (await this.#files.exists(tempRelative)) {
          throw new ArtifactStoreError("unsafe_state", "The metadata publication alias changed.");
        }
        const record = await this.#readDescriptorRecord(descriptor.artifactId);
        if (!record.bytes.equals(metadataBytes)) {
          throw new ArtifactStoreError("metadata_conflict", "Immutable metadata disagrees.");
        }
        await this.#boundary("metadata.publish-temp-unlinked");
      }
      await this.#boundary("metadata.publish-temp-unlink-directory-synced");
    } else {
      try {
        await this.#assertWinnerBytes(tempRelative, canonicalRelative);
      } catch (error) {
        if (isArtifactStoreError(error) && error.code === "integrity_mismatch") {
          throw new ArtifactStoreError("metadata_conflict", "Immutable metadata disagrees.");
        }
        throw error;
      }
      await this.#files.remove(tempRelative);
    }
    await this.#boundary("metadata.published");
    if (!sameArtifactMetadata(await this.#readDescriptor(descriptor.artifactId), descriptor)) {
      throw new ArtifactStoreError("metadata_conflict", "Published metadata changed.");
    }
    await this.#boundary("metadata.verified");
    return metadataBytes;
  }

  async #findArtifactInternal(artifactId: ArtifactId): Promise<ArtifactDescriptor | undefined> {
    const descriptor = await this.#readCommittedDescriptor(artifactId);
    if (descriptor === undefined) return undefined;
    await this.#verifyBlob(descriptor);
    return descriptor;
  }

  async #readCommittedDescriptor(artifactId: ArtifactId): Promise<ArtifactDescriptor | undefined> {
    if (!(await this.#transactions.hasCommittedMarker(artifactId))) return undefined;
    const record = await this.#readDescriptorRecord(artifactId);
    if (
      (await this.#transactions.readCommittedMetadataHash(artifactId)) !==
      createHash("sha256").update(record.bytes).digest("hex")
    ) {
      throw new ArtifactStoreError("integrity_mismatch", "Committed artifact state disagrees.");
    }
    return record.descriptor;
  }

  async #compareExisting(
    existing: ArtifactDescriptor,
    request: AdmittedWriteArtifactRequest
  ): Promise<ArtifactDescriptor> {
    const attempt = await this.#transactions.begin(existing.artifactId);
    try {
      const streamed = await this.#writeBlobTemp(attempt, request);
      const candidate = descriptorForDigest(request.metadata, streamed.digest, streamed.byteSize);
      if (!sameArtifactMetadata(existing, candidate)) {
        throw new ArtifactStoreError("metadata_conflict", "Immutable metadata disagrees.");
      }
      await this.#assertWinnerBytes(
        this.#transactions.streamTempRelative(attempt),
        this.#transactions.blobRelative(existing.digest)
      );
      return existing;
    } finally {
      await this.#transactions.cleanupAttempt(attempt);
    }
  }

  #assertWriteRequest(request: AdmittedWriteArtifactRequest): void {
    if (!Number.isSafeInteger(request.maximumBytes) || request.maximumBytes < 0) {
      throw new ArtifactStoreError(
        "artifact_too_large",
        "A valid artifact byte limit is required."
      );
    }
    descriptorForDigest(request.metadata, "0".repeat(64), 0);
    if (
      redactCompleteText(JSON.stringify(request.metadata), request.sensitiveValues)
        .sensitiveDetected
    ) {
      throw new ArtifactStoreError("invalid_metadata", "Artifact metadata is invalid or unsafe.");
    }
  }

  async #forEachContentChunk(
    content: AsyncIterable<Uint8Array>,
    maximumBytes: number,
    visit: (chunk: Buffer) => Promise<void>
  ): Promise<void> {
    let iterator: AsyncIterator<Uint8Array>;
    let admittedBytes = 0;
    try {
      iterator = content[Symbol.asyncIterator]();
    } catch {
      throw new ArtifactStoreError("filesystem_error", "Artifact content could not be consumed.");
    }
    try {
      for (;;) {
        let result: IteratorResult<Uint8Array>;
        try {
          result = await iterator.next();
        } catch {
          throw new ArtifactStoreError("filesystem_error", "Artifact content iteration failed.");
        }
        let done: boolean;
        try {
          done = Boolean(result.done);
        } catch {
          throw new ArtifactStoreError("filesystem_error", "Artifact content iteration failed.");
        }
        if (done) {
          return;
        }
        let value: Uint8Array;
        try {
          value = result.value;
        } catch {
          throw new ArtifactStoreError("filesystem_error", "Artifact content iteration failed.");
        }
        let byteLength: number;
        try {
          if (!utilTypes.isUint8Array(value)) throw new TypeError();
          if (typedArrayByteLength === undefined) throw new TypeError();
          byteLength = typedArrayByteLength.call(value) as number;
        } catch {
          throw new ArtifactStoreError("filesystem_error", "Artifact content must be byte chunks.");
        }
        if (byteLength > maximumBytes - admittedBytes) {
          throw new ArtifactStoreError("artifact_too_large", "Artifact byte limit exceeded.");
        }
        admittedBytes += byteLength;
        let chunk: Buffer;
        try {
          chunk = Buffer.from(value);
        } catch {
          throw new ArtifactStoreError("filesystem_error", "Artifact content must be byte chunks.");
        }
        await visit(chunk);
      }
    } catch (error) {
      try {
        const cleanup = iterator.return?.();
        if (cleanup !== undefined) void Promise.resolve(cleanup).catch(() => undefined);
      } catch {
        // User iterator cleanup cannot replace the static public error.
      }
      throw error;
    }
  }

  async #verifyBlob(
    descriptor: ArtifactDescriptor,
    sensitiveValues: readonly string[] = [],
    range?: { readonly offset: number; readonly length: number },
    expectedIdentity?: FileIdentitySnapshot
  ): Promise<Buffer> {
    let handle: FileHandle;
    try {
      handle = await this.#files.openRead(
        this.#transactions.blobRelative(descriptor.digest),
        "integrity_mismatch"
      );
    } catch {
      throw new ArtifactStoreError("integrity_mismatch", "The artifact blob is unavailable.");
    }
    try {
      return await usingFileHandle(handle, async () => {
        const selection =
          range === undefined
            ? undefined
            : {
                offset: range.offset,
                length: Math.min(range.length, descriptor.byteSize - range.offset)
              };
        const inspected = await inspectArtifactHandle(
          handle,
          sensitiveValues,
          selection,
          descriptor.byteSize
        );
        if (inspected.sensitiveDetected) {
          throw new ArtifactStoreError("sensitive_artifact", "Credential material is forbidden.");
        }
        if (
          inspected.byteSize !== descriptor.byteSize ||
          inspected.digest !== descriptor.digest ||
          (expectedIdentity !== undefined &&
            !sameFileIdentity(expectedIdentity, inspected.identity))
        ) {
          throw new ArtifactStoreError(
            "integrity_mismatch",
            "Artifact digest verification failed."
          );
        }
        return inspected.selectedBytes;
      });
    } catch (error) {
      if (isArtifactStoreError(error)) throw error;
      throw new ArtifactStoreError("integrity_mismatch", "Artifact inode verification failed.");
    }
  }

  async #inspectRelativeFile(
    relativePath: string,
    sensitiveValues: readonly string[],
    expectedByteSize?: number
  ) {
    const handle = await this.#files.openRead(relativePath, "integrity_mismatch");
    try {
      return await usingFileHandle(handle, (opened) =>
        inspectArtifactHandle(opened, sensitiveValues, undefined, expectedByteSize)
      );
    } catch (error) {
      if (isArtifactStoreError(error)) throw error;
      throw new ArtifactStoreError("integrity_mismatch", "Artifact inode verification failed.");
    }
  }

  async #assertWinnerBytes(attemptRelative: string, canonicalRelative: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      try {
        const attemptHandle = await this.#files.openRead(attemptRelative, "integrity_mismatch");
        return await usingFileHandle(attemptHandle, async (openedAttempt) => {
          const canonicalHandle = await this.#files.openRead(canonicalRelative, "unsafe_state");
          return usingFileHandle(canonicalHandle, async (openedCanonical) => {
            if (!(await artifactHandlesHaveEqualBytes(openedAttempt, openedCanonical))) {
              throw new ArtifactStoreError("integrity_mismatch", "Artifact bytes disagree.");
            }
          });
        });
      } catch (error) {
        lastError = error;
        if (!isArtifactStoreError(error) || error.code !== "unsafe_state") throw error;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    throw normalizeArtifactError(lastError, "unsafe_state");
  }

  async #readDescriptor(
    artifactId: ArtifactId,
    expectedIdentity?: FileIdentitySnapshot
  ): Promise<ArtifactDescriptor> {
    return (await this.#readDescriptorRecord(artifactId, expectedIdentity)).descriptor;
  }

  async #readDescriptorRecord(
    artifactId: ArtifactId,
    expectedIdentity?: FileIdentitySnapshot
  ): Promise<{ readonly descriptor: ArtifactDescriptor; readonly bytes: Buffer }> {
    let bytes: Buffer;
    try {
      bytes = await this.#files.readBounded(
        this.#transactions.metadataRelative(artifactId),
        MAX_METADATA_BYTES,
        expectedIdentity
      );
    } catch (error) {
      throw normalizeArtifactError(error, "unsafe_state");
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new ArtifactStoreError("integrity_mismatch", "Artifact metadata is invalid.");
    }
    const parsed = ArtifactDescriptorSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.artifactId !== artifactId) {
      throw new ArtifactStoreError("integrity_mismatch", "Artifact metadata is inconsistent.");
    }
    return { descriptor: parsed.data, bytes };
  }

  async #openCreatedFile(
    relativePath: string,
    openedBoundary: ArtifactWriteBoundary,
    parentBoundary: ArtifactWriteBoundary
  ): Promise<FileHandle> {
    const handle = await this.#files.create(relativePath);
    try {
      await this.#boundary(openedBoundary);
      await this.#boundary(parentBoundary);
      return handle;
    } catch (error) {
      await closeFileHandleAfterFailure(handle);
      throw error;
    }
  }

  async #boundary(boundary: ArtifactWriteBoundary): Promise<void> {
    if (this.#onBoundary === undefined) return;
    try {
      await this.#onBoundary(boundary);
    } catch {
      throw new ArtifactStoreError("filesystem_error", "An artifact durability boundary failed.");
    }
  }
}
