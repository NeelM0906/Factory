import { createHash, randomBytes } from "node:crypto";
import type { FileHandle } from "node:fs/promises";

import type { ArtifactDescriptor, ArtifactId } from "@autostack/contracts";

import { ArtifactFiles } from "./artifact-files.js";
import {
  decodeArtifactIdFilenameComponent,
  encodeArtifactIdFilenameComponent
} from "./artifact-id-filename.js";
import { syncArtifactFile, writeAll } from "./artifact-io.js";
import {
  ArtifactStoreError,
  normalizeArtifactError,
  type ArtifactWriteBoundary
} from "./artifact-types.js";
import type { ConfinedDirectoryEntry } from "./path-policy.js";
import { closeFileHandleAfterFailure, usingFileHandle } from "./file-handle-lifecycle.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ATTEMPT_PATTERN = /^[0-9a-f]{32}$/;
// One terminal command may own one artifact. Each artifact namespace may contain a canonical
// entry plus one crash alias, while tmp may retain one in-progress stream per admitted command.
const MAXIMUM_LIFECYCLE_ARTIFACTS = 10_000;
const MAXIMUM_RECOVERY_DIRECTORY_ENTRIES = MAXIMUM_LIFECYCLE_ARTIFACTS * 2;
const MAXIMUM_DIGEST_PREFIX_DIRECTORIES = 256;
const MAXIMUM_RECOVERY_ENTRIES =
  MAXIMUM_LIFECYCLE_ARTIFACTS * 7 + MAXIMUM_DIGEST_PREFIX_DIRECTORIES;

interface ArtifactRecoveryBudget {
  remainingEntries: number;
}

export interface ArtifactAttempt {
  readonly artifactId: ArtifactId;
  readonly attemptId: string;
}

export interface ArtifactRecoveryVerifier {
  verifyCommitted(artifactId: ArtifactId, metadataHash: string): Promise<void>;
}

export class ArtifactTransactions {
  readonly #files: ArtifactFiles;
  readonly #boundary: (boundary: ArtifactWriteBoundary) => Promise<void>;

  constructor(files: ArtifactFiles, boundary: (boundary: ArtifactWriteBoundary) => Promise<void>) {
    this.#files = files;
    this.#boundary = boundary;
  }

  async begin(artifactId: ArtifactId): Promise<ArtifactAttempt> {
    const attempt: ArtifactAttempt = {
      artifactId,
      attemptId: randomBytes(16).toString("hex")
    };
    const handle = await this.#openCreated(
      this.pendingRelative(attempt),
      "transaction.file-opened",
      "transaction.creation-parent-synced"
    );
    await usingFileHandle(handle, async () => {
      await syncArtifactFile(handle);
    });
    await this.#boundary("transaction.file-synced");
    await this.#files.syncDirectory("artifacts/transactions");
    await this.#boundary("transaction.directory-synced");
    return attempt;
  }

  async commit(
    attempt: ArtifactAttempt,
    descriptor: ArtifactDescriptor,
    metadataBytes: Uint8Array
  ): Promise<void> {
    const metadataHash = createHash("sha256").update(metadataBytes).digest("hex");
    const tempRelative = this.commitTempRelative(attempt);
    const canonicalRelative = this.committedRelative(descriptor.artifactId);
    const handle = await this.#openCreated(
      tempRelative,
      "transaction.committed-file-opened",
      "transaction.committed-creation-parent-synced"
    );
    await usingFileHandle(handle, async () => {
      await writeAll(handle, Buffer.from(`${metadataHash}\n`), 0);
      await syncArtifactFile(handle);
    });
    await this.#boundary("transaction.committed-file-synced");
    const linked = await this.#files.linkNoReplace(tempRelative, canonicalRelative);
    if (linked) {
      await this.#boundary("transaction.committed-linked");
      await this.#files.syncDirectory("artifacts/transactions");
      await this.#boundary("transaction.committed-directory-synced");
      const healed = await this.#files.healLinkedAlias(tempRelative, canonicalRelative, () =>
        this.#boundary("transaction.commit-temp-unlinked")
      );
      if (!healed) {
        if (await this.#files.exists(tempRelative)) {
          throw new ArtifactStoreError("unsafe_state", "A commit alias could not be finalized.");
        }
        if ((await this.readCommittedMetadataHash(descriptor.artifactId)) !== metadataHash) {
          throw new ArtifactStoreError("metadata_conflict", "Committed artifact state disagrees.");
        }
        await this.#boundary("transaction.commit-temp-unlinked");
      }
      await this.#boundary("transaction.commit-temp-unlink-directory-synced");
      return;
    }
    if ((await this.#waitForCommittedMetadataHash(descriptor.artifactId)) !== metadataHash) {
      throw new ArtifactStoreError("metadata_conflict", "Committed artifact state disagrees.");
    }
    await this.#files.remove(tempRelative);
  }

  async finish(attempt: ArtifactAttempt): Promise<void> {
    await this.#files.remove(this.pendingRelative(attempt));
    await this.#boundary("transaction.removed");
    await this.#files.syncDirectory("artifacts/transactions");
    await this.#boundary("transaction.directory-synced-final");
  }

  async cleanupAttempt(attempt: ArtifactAttempt, descriptor?: ArtifactDescriptor): Promise<void> {
    if (descriptor !== undefined) {
      await this.#healThenRemove(
        this.blobPublishTempRelative(attempt, descriptor.digest),
        this.blobRelative(descriptor.digest)
      );
      await this.#healThenRemove(
        this.metadataTempRelative(attempt),
        this.metadataRelative(descriptor.artifactId)
      );
      await this.#healThenRemove(
        this.commitTempRelative(attempt),
        this.committedRelative(descriptor.artifactId)
      );
    }
    await this.#files.remove(this.streamTempRelative(attempt));
    await this.#files.remove(this.pendingRelative(attempt));
    await this.#files.syncDirectory("artifacts/tmp");
    await this.#files.syncDirectory("artifacts/transactions");
  }

  async hasCommittedMarker(artifactId: ArtifactId): Promise<boolean> {
    return this.#files.exists(this.committedRelative(artifactId));
  }

  async readCommittedMetadataHash(artifactId: ArtifactId): Promise<string> {
    let bytes: Buffer;
    try {
      bytes = await this.#files.readBounded(this.committedRelative(artifactId), 65);
    } catch (error) {
      throw normalizeArtifactError(error, "unsafe_state");
    }
    const hash = bytes.toString("utf8").trimEnd();
    if (!SHA256_PATTERN.test(hash) || bytes.toString("utf8") !== `${hash}\n`) {
      throw new ArtifactStoreError("integrity_mismatch", "Committed artifact state is invalid.");
    }
    return hash;
  }

  async recover(verifier: ArtifactRecoveryVerifier): Promise<void> {
    const committed = new Set<ArtifactId>();
    const budget = { remainingEntries: MAXIMUM_RECOVERY_ENTRIES };
    await this.#recoverTransactionDirectory(committed, budget);
    await this.#recoverMetadataDirectory(budget);
    await this.#recoverBlobDirectories(budget);
    await this.#validateStreamTemps(budget);
    for (const artifactId of committed) {
      await verifier.verifyCommitted(artifactId, await this.readCommittedMetadataHash(artifactId));
    }
  }

  blobRelative(digest: string): string {
    return `artifacts/sha256/${digest.slice(0, 2)}/${digest}`;
  }

  metadataRelative(artifactId: ArtifactId): string {
    return `artifacts/metadata/${encodeArtifactIdFilenameComponent(artifactId)}.json`;
  }

  streamTempRelative(attempt: ArtifactAttempt): string {
    return `artifacts/tmp/${encodeArtifactIdFilenameComponent(attempt.artifactId)}.${attempt.attemptId}.blob.tmp`;
  }

  blobPublishTempRelative(attempt: ArtifactAttempt, digest: string): string {
    return `artifacts/sha256/${digest.slice(0, 2)}/${digest}.${attempt.attemptId}.publish.tmp`;
  }

  metadataTempRelative(attempt: ArtifactAttempt): string {
    return `artifacts/metadata/${encodeArtifactIdFilenameComponent(attempt.artifactId)}.${attempt.attemptId}.metadata.tmp`;
  }

  pendingRelative(attempt: ArtifactAttempt): string {
    return `artifacts/transactions/${encodeArtifactIdFilenameComponent(attempt.artifactId)}.${attempt.attemptId}.pending`;
  }

  commitTempRelative(attempt: ArtifactAttempt): string {
    return `artifacts/transactions/${encodeArtifactIdFilenameComponent(attempt.artifactId)}.${attempt.attemptId}.commit.tmp`;
  }

  committedRelative(artifactId: ArtifactId): string {
    return `artifacts/transactions/${encodeArtifactIdFilenameComponent(artifactId)}.committed`;
  }

  async #openCreated(
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

  async #healThenRemove(aliasRelative: string, canonicalRelative: string): Promise<void> {
    if (await this.#files.healLinkedAlias(aliasRelative, canonicalRelative)) return;
    await this.#files.remove(aliasRelative);
  }

  async #waitForCommittedMetadataHash(artifactId: ArtifactId): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      try {
        return await this.readCommittedMetadataHash(artifactId);
      } catch (error) {
        lastError = error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      }
    }
    throw normalizeArtifactError(lastError, "unsafe_state");
  }

  async #recoverTransactionDirectory(
    committed: Set<ArtifactId>,
    budget: ArtifactRecoveryBudget
  ): Promise<void> {
    const entries = await this.#readDirectory("artifacts/transactions", budget);
    const commitTemps: Array<{ alias: string; canonical: string; artifactId: ArtifactId }> = [];
    const aliasPairs: Array<readonly [string, string]> = [];
    for (const entry of entries) {
      if (entry.type !== "file") {
        throw new ArtifactStoreError("unsafe_state", "Unexpected transaction state is present.");
      }
      const committedArtifactId = this.#artifactIdWithSuffix(entry.name, ".committed");
      if (committedArtifactId !== undefined) {
        committed.add(committedArtifactId);
        continue;
      }
      const pending = this.#attemptWithSuffix(entry.name, ".pending");
      if (pending !== undefined) {
        continue;
      }
      const commitTemp = this.#attemptWithSuffix(entry.name, ".commit.tmp");
      if (commitTemp !== undefined) {
        const { artifactId } = commitTemp;
        commitTemps.push({
          alias: `artifacts/transactions/${entry.name}`,
          canonical: this.committedRelative(artifactId),
          artifactId
        });
        aliasPairs.push([entry.name, `${encodeArtifactIdFilenameComponent(artifactId)}.committed`]);
        continue;
      }
      throw new ArtifactStoreError("unsafe_state", "Unexpected transaction state is present.");
    }
    this.#assertRecognizedAliasTopology(entries, aliasPairs);
    for (const temp of commitTemps) {
      if (await this.#files.healLinkedAlias(temp.alias, temp.canonical)) {
        committed.add(temp.artifactId);
      }
    }
  }

  async #recoverMetadataDirectory(budget: ArtifactRecoveryBudget): Promise<void> {
    const entries = await this.#readDirectory("artifacts/metadata", budget);
    const aliases: Array<{ entry: ConfinedDirectoryEntry; artifactId: ArtifactId }> = [];
    const aliasPairs: Array<readonly [string, string]> = [];
    for (const entry of entries) {
      if (entry.type !== "file") {
        throw new ArtifactStoreError("unsafe_state", "Unexpected artifact metadata is present.");
      }
      const canonicalArtifactId = this.#artifactIdWithSuffix(entry.name, ".json");
      if (canonicalArtifactId !== undefined) {
        continue;
      }
      const metadataTemp = this.#attemptWithSuffix(entry.name, ".metadata.tmp");
      if (metadataTemp === undefined) {
        throw new ArtifactStoreError("unsafe_state", "Unexpected artifact metadata is present.");
      }
      const { artifactId } = metadataTemp;
      aliases.push({ entry, artifactId });
      aliasPairs.push([entry.name, `${encodeArtifactIdFilenameComponent(artifactId)}.json`]);
    }
    this.#assertRecognizedAliasTopology(entries, aliasPairs);
    for (const { entry, artifactId } of aliases) {
      await this.#files.healLinkedAlias(
        `artifacts/metadata/${entry.name}`,
        this.metadataRelative(artifactId)
      );
    }
  }

  async #recoverBlobDirectories(budget: ArtifactRecoveryBudget): Promise<void> {
    const prefixes = await this.#readDirectory("artifacts/sha256", budget);
    for (const prefixEntry of prefixes) {
      const prefix = prefixEntry.name;
      if (prefixEntry.type !== "directory" || !/^[0-9a-f]{2}$/.test(prefix)) {
        throw new ArtifactStoreError("unsafe_state", "Unexpected digest state is present.");
      }
      const entries = await this.#readDirectory(`artifacts/sha256/${prefix}`, budget);
      const aliases: Array<{ entry: ConfinedDirectoryEntry; digest: string }> = [];
      const aliasPairs: Array<readonly [string, string]> = [];
      for (const entry of entries) {
        if (entry.type !== "file") {
          throw new ArtifactStoreError("unsafe_state", "Unexpected digest state is present.");
        }
        if (SHA256_PATTERN.test(entry.name) && entry.name.startsWith(prefix)) continue;
        const match = /^([0-9a-f]{64})\.([0-9a-f]{32})\.publish\.tmp$/.exec(entry.name);
        if (match === null || !match[1]!.startsWith(prefix) || !ATTEMPT_PATTERN.test(match[2]!)) {
          throw new ArtifactStoreError("unsafe_state", "Unexpected digest state is present.");
        }
        aliases.push({ entry, digest: match[1]! });
        aliasPairs.push([entry.name, match[1]!]);
      }
      this.#assertRecognizedAliasTopology(entries, aliasPairs);
      for (const { entry, digest } of aliases) {
        await this.#files.healLinkedAlias(
          `artifacts/sha256/${prefix}/${entry.name}`,
          this.blobRelative(digest)
        );
      }
    }
  }

  async #validateStreamTemps(budget: ArtifactRecoveryBudget): Promise<void> {
    const entries = await this.#readDirectory("artifacts/tmp", budget);
    for (const entry of entries) {
      const streamTemp = this.#attemptWithSuffix(entry.name, ".blob.tmp");
      if (entry.type !== "file" || entry.identity.nlink !== 1 || streamTemp === undefined) {
        throw new ArtifactStoreError("unsafe_state", "Unexpected artifact temporary state exists.");
      }
    }
  }

  #assertRecognizedAliasTopology(
    entries: readonly ConfinedDirectoryEntry[],
    pairs: readonly (readonly [string, string])[]
  ): void {
    const linkedNamesByInode = new Map<string, Set<string>>();
    for (const entry of entries) {
      if (entry.type !== "file" || entry.identity.nlink !== 2) continue;
      const inodeKey = `${entry.identity.dev}:${entry.identity.ino}`;
      const names = linkedNamesByInode.get(inodeKey) ?? new Set<string>();
      names.add(entry.name);
      linkedNamesByInode.set(inodeKey, names);
    }
    const counterpartNames = new Map<string, string[]>();
    for (const [alias, canonical] of pairs) {
      counterpartNames.set(alias, [canonical]);
      counterpartNames.set(canonical, [...(counterpartNames.get(canonical) ?? []), alias]);
    }
    for (const entry of entries) {
      if (entry.type !== "file" || entry.identity.nlink === 1) continue;
      const linkedNames = linkedNamesByInode.get(`${entry.identity.dev}:${entry.identity.ino}`);
      const hasRecognizedCounterpart = (counterpartNames.get(entry.name) ?? []).some((otherName) =>
        linkedNames?.has(otherName)
      );
      if (!hasRecognizedCounterpart) {
        throw new ArtifactStoreError("unsafe_state", "A recovery link has no recognized alias.");
      }
    }
  }

  #tryParseRecoveryArtifactId(value: string): ArtifactId | undefined {
    return decodeArtifactIdFilenameComponent(value);
  }

  #artifactIdWithSuffix(name: string, suffix: string): ArtifactId | undefined {
    if (!name.endsWith(suffix)) return undefined;
    return this.#tryParseRecoveryArtifactId(name.slice(0, -suffix.length));
  }

  #attemptWithSuffix(
    name: string,
    suffix: string
  ): { readonly artifactId: ArtifactId; readonly attemptId: string } | undefined {
    if (!name.endsWith(suffix)) return undefined;
    const stem = name.slice(0, -suffix.length);
    const separator = stem.lastIndexOf(".");
    if (separator < 1) return undefined;
    const attemptId = stem.slice(separator + 1);
    if (!ATTEMPT_PATTERN.test(attemptId)) return undefined;
    const artifactId = this.#tryParseRecoveryArtifactId(stem.slice(0, separator));
    return artifactId === undefined ? undefined : { artifactId, attemptId };
  }

  async #readDirectory(
    relativePath: string,
    budget: ArtifactRecoveryBudget
  ): Promise<readonly ConfinedDirectoryEntry[]> {
    try {
      const maximum = Math.min(MAXIMUM_RECOVERY_DIRECTORY_ENTRIES, budget.remainingEntries);
      const entries = await this.#files.listExistingDirectory(relativePath, maximum);
      if (entries === undefined) throw new TypeError();
      budget.remainingEntries -= entries.length;
      return entries;
    } catch {
      throw new ArtifactStoreError("unsafe_state", "Artifact transaction state is unavailable.");
    }
  }
}
