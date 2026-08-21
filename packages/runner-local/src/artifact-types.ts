import {
  ArtifactDescriptorSchema,
  ArtifactIdSchema,
  CONFIGURED_SECRET_LIMITS,
  type ArtifactDescriptor,
  type ArtifactId
} from "@autostack/contracts";

export const ARTIFACT_WRITE_BOUNDARIES = Object.freeze([
  "transaction.file-opened",
  "transaction.creation-parent-synced",
  "transaction.file-synced",
  "transaction.directory-synced",
  "blob.file-opened",
  "blob.creation-parent-synced",
  "blob.file-synced",
  "blob.directory-synced",
  "blob.before-publish",
  "transaction.publishing-file-opened",
  "transaction.publishing-creation-parent-synced",
  "transaction.publishing-file-synced",
  "transaction.publishing-directory-synced",
  "blob.final-file-opened",
  "blob.final-creation-parent-synced",
  "blob.canonical-linked",
  "blob.canonical-directory-synced",
  "blob.publish-temp-unlinked",
  "blob.publish-temp-unlink-directory-synced",
  "blob.final-file-synced",
  "blob.final-directory-synced",
  "blob.published",
  "blob.verified",
  "metadata.before-publish",
  "metadata.file-opened",
  "metadata.creation-parent-synced",
  "metadata.file-synced",
  "metadata.directory-synced",
  "metadata.canonical-linked",
  "metadata.canonical-directory-synced",
  "metadata.publish-temp-unlinked",
  "metadata.publish-temp-unlink-directory-synced",
  "metadata.published",
  "metadata.verified",
  "transaction.committed-file-opened",
  "transaction.committed-creation-parent-synced",
  "transaction.committed-file-synced",
  "transaction.committed-linked",
  "transaction.committed-directory-synced",
  "transaction.commit-temp-unlinked",
  "transaction.commit-temp-unlink-directory-synced",
  "transaction.removed",
  "transaction.directory-synced-final"
] as const);

export type ArtifactWriteBoundary = (typeof ARTIFACT_WRITE_BOUNDARIES)[number];

export type ArtifactWriteMetadata = Pick<
  ArtifactDescriptor,
  "artifactId" | "workspaceId" | "runId" | "commandId" | "kind" | "mediaType" | "createdAt"
>;

export interface WriteArtifactRequest {
  readonly metadata: ArtifactWriteMetadata;
  readonly content: AsyncIterable<Uint8Array>;
  readonly maximumBytes: number;
  readonly sensitiveValues?: readonly string[];
}

export interface AdmittedWriteArtifactRequest {
  readonly metadata: ArtifactWriteMetadata;
  readonly content: AsyncIterable<Uint8Array>;
  readonly maximumBytes: number;
  readonly sensitiveValues: readonly string[];
}

export interface ArtifactStoreOptions {
  readonly dataRoot: string;
  readonly onBoundary?: (boundary: ArtifactWriteBoundary) => Promise<void> | void;
}

export type ArtifactStoreErrorCode =
  | "invalid_metadata"
  | "artifact_too_large"
  | "sensitive_artifact"
  | "integrity_mismatch"
  | "metadata_conflict"
  | "invalid_read"
  | "unsafe_state"
  | "filesystem_error";

export class ArtifactStoreError extends Error {
  readonly code: ArtifactStoreErrorCode;

  constructor(code: ArtifactStoreErrorCode, message: string) {
    super(message);
    this.name = "ArtifactStoreError";
    this.code = code;
    ownedArtifactStoreErrors.add(this);
  }
}

const ownedArtifactStoreErrors = new WeakSet<object>();

export const isArtifactStoreError = (value: unknown): value is ArtifactStoreError =>
  ((typeof value === "object" && value !== null) || typeof value === "function") &&
  ownedArtifactStoreErrors.has(value);

export interface ArtifactReadResult {
  readonly descriptor: ArtifactDescriptor;
  readonly offset: number;
  readonly bytes: Buffer;
  readonly nextOffset: number;
  readonly done: boolean;
}

export const STATIC_ERROR_MESSAGES: Readonly<Record<ArtifactStoreErrorCode, string>> =
  Object.freeze({
    invalid_metadata: "Artifact metadata is invalid or unsafe.",
    artifact_too_large: "The artifact exceeded its configured byte limit.",
    sensitive_artifact: "Credential material is forbidden in finalized artifacts.",
    integrity_mismatch: "Artifact integrity verification failed.",
    metadata_conflict: "Immutable artifact metadata conflicts with existing state.",
    invalid_read: "The artifact read request is invalid or unavailable.",
    unsafe_state: "Private artifact state failed closed validation.",
    filesystem_error: "The private artifact operation failed safely."
  });

export const normalizeArtifactError = (
  error: unknown,
  fallbackCode: ArtifactStoreErrorCode = "filesystem_error"
): ArtifactStoreError => {
  const code = isArtifactStoreError(error) ? error.code : fallbackCode;
  return new ArtifactStoreError(code, STATIC_ERROR_MESSAGES[code]);
};

export const parseArtifactId = (value: unknown): ArtifactId => {
  const parsed = ArtifactIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new ArtifactStoreError("invalid_metadata", STATIC_ERROR_MESSAGES.invalid_metadata);
  }
  return parsed.data;
};

export const snapshotArtifactMetadata = (value: ArtifactWriteMetadata): ArtifactWriteMetadata => ({
  artifactId: value.artifactId,
  workspaceId: value.workspaceId,
  runId: value.runId,
  commandId: value.commandId,
  kind: value.kind,
  mediaType: value.mediaType,
  createdAt: value.createdAt
});

const observeSensitiveIteratorCleanup = (iterator: Iterator<unknown>): void => {
  try {
    const cleanup = iterator.return;
    if (typeof cleanup !== "function") return;
    const outcome = cleanup.call(iterator);
    void Promise.resolve(outcome).catch(() => undefined);
  } catch {
    // Hostile iterator cleanup cannot replace the static admission error.
  }
};

export const snapshotSensitiveValues = (input: unknown): readonly string[] => {
  if (input === undefined) return Object.freeze([]);
  let iterator: Iterator<unknown> | undefined;
  try {
    if ((typeof input !== "object" || input === null) && typeof input !== "function") {
      throw new TypeError();
    }
    const iteratorMethod = (input as Iterable<unknown>)[Symbol.iterator];
    if (typeof iteratorMethod !== "function") throw new TypeError();
    iterator = iteratorMethod.call(input) as Iterator<unknown>;
    if ((typeof iterator !== "object" || iterator === null) && typeof iterator !== "function") {
      throw new TypeError();
    }
    const next = iterator.next;
    if (typeof next !== "function") throw new TypeError();
    const values: string[] = [];
    let yieldedCount = 0;
    let aggregateCharacters = 0;
    for (;;) {
      const result = next.call(iterator);
      const done = Boolean(result.done);
      if (done) return Object.freeze(values);
      if (yieldedCount >= CONFIGURED_SECRET_LIMITS.maximumCount) throw new TypeError();
      yieldedCount += 1;
      const value = result.value;
      if (typeof value !== "string") throw new TypeError();
      if (
        value.length >
        CONFIGURED_SECRET_LIMITS.maximumAggregateCharacters - aggregateCharacters
      ) {
        throw new TypeError();
      }
      aggregateCharacters += value.length;
      if (value.length > 0) values.push(value);
    }
  } catch {
    if (iterator !== undefined) observeSensitiveIteratorCleanup(iterator);
    throw new ArtifactStoreError("invalid_metadata", STATIC_ERROR_MESSAGES.invalid_metadata);
  }
};

export const descriptorForDigest = (
  metadata: ArtifactWriteMetadata,
  digest: string,
  byteSize: number
): ArtifactDescriptor => {
  const parsed = ArtifactDescriptorSchema.safeParse({ ...metadata, digest, byteSize });
  if (!parsed.success) {
    throw new ArtifactStoreError("invalid_metadata", STATIC_ERROR_MESSAGES.invalid_metadata);
  }
  return parsed.data;
};

export const sameArtifactMetadata = (
  left: ArtifactDescriptor,
  right: ArtifactDescriptor
): boolean => JSON.stringify(left) === JSON.stringify(right);
