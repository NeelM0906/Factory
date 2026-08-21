import type { FileHandle } from "node:fs/promises";

import {
  assertPrivateArtifactStatus,
  sameFileIdentity,
  snapshotFileIdentity,
  type FileIdentitySnapshot
} from "./artifact-io.js";
import {
  ArtifactStoreError,
  normalizeArtifactError,
  type ArtifactStoreErrorCode
} from "./artifact-types.js";
import { usingFileHandle } from "./file-handle-lifecycle.js";
import { DataPathPolicy, type ConfinedDirectoryEntry } from "./path-policy.js";

/** Serializes namespace mutations through the pinned AutoStack path policy. */
export class ArtifactFiles {
  readonly #paths: DataPathPolicy;
  #filesystemTail: Promise<void> = Promise.resolve();

  constructor(paths: DataPathPolicy) {
    this.#paths = paths;
  }

  get root(): string {
    return this.#paths.root;
  }

  async create(relativePath: string): Promise<FileHandle> {
    return this.#serialized(async () => {
      await this.#refreshParent(relativePath);
      return this.#paths.openFile(relativePath, "wx");
    });
  }

  async openRead(relativePath: string, fallbackCode: ArtifactStoreErrorCode): Promise<FileHandle> {
    try {
      return await this.#serialized(async () => {
        await this.#refreshParent(relativePath);
        return this.#paths.openFile(relativePath, "r");
      });
    } catch (error) {
      throw normalizeArtifactError(error, fallbackCode);
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      return await this.#serialized(async () => {
        await this.#refreshParent(relativePath);
        return this.#paths.fileExists(relativePath);
      });
    } catch (error) {
      throw normalizeArtifactError(error, "unsafe_state");
    }
  }

  async remove(relativePath: string): Promise<void> {
    try {
      await this.#serialized(async () => {
        await this.#refreshParent(relativePath);
        await this.#paths.unlinkFile(relativePath);
      });
    } catch (error) {
      throw normalizeArtifactError(error, "unsafe_state");
    }
  }

  async linkNoReplace(
    sourceRelativePath: string,
    destinationRelativePath: string
  ): Promise<boolean> {
    try {
      return await this.#serialized(async () => {
        await this.#refreshParent(sourceRelativePath);
        await this.#refreshParent(destinationRelativePath);
        return this.#paths.linkFileNoReplace(sourceRelativePath, destinationRelativePath);
      });
    } catch (error) {
      throw normalizeArtifactError(error, "unsafe_state");
    }
  }

  async healLinkedAlias(
    aliasRelativePath: string,
    canonicalRelativePath: string,
    afterUnlink?: () => Promise<void>
  ): Promise<boolean> {
    let boundaryFailed = false;
    let boundaryError: unknown;
    try {
      return await this.#serialized(async () => {
        await this.#refreshParent(aliasRelativePath);
        await this.#refreshParent(canonicalRelativePath);
        return this.#paths.healLinkedAlias(
          aliasRelativePath,
          canonicalRelativePath,
          afterUnlink === undefined
            ? undefined
            : async () => {
                try {
                  await afterUnlink();
                } catch (error) {
                  boundaryFailed = true;
                  boundaryError = error;
                  throw error;
                }
              }
        );
      });
    } catch (error) {
      if (boundaryFailed) throw normalizeArtifactError(boundaryError, "filesystem_error");
      throw normalizeArtifactError(error, "unsafe_state");
    }
  }

  async syncDirectory(relativePath: string): Promise<void> {
    try {
      await this.#serialized(async () => {
        await this.#paths.refreshDirectoryChainAfterConcurrentEntryChange(relativePath);
        await this.#paths.syncDirectory(relativePath);
      });
    } catch (error) {
      throw normalizeArtifactError(error, "unsafe_state");
    }
  }

  async ensureDirectory(relativePath: string): Promise<void> {
    try {
      await this.#serialized(async () => {
        await this.#paths.refreshDirectoryChainAfterConcurrentEntryChange(relativePath);
        await this.#paths.ensureDirectory(relativePath);
      });
    } catch (error) {
      throw normalizeArtifactError(error, "unsafe_state");
    }
  }

  async listDirectory(relativePath: string): Promise<readonly ConfinedDirectoryEntry[]> {
    try {
      return await this.#serialized(async () => {
        await this.#paths.refreshDirectoryChainAfterConcurrentEntryChange(relativePath);
        return this.#paths.listDirectory(relativePath);
      });
    } catch (error) {
      throw normalizeArtifactError(error, "unsafe_state");
    }
  }

  async refreshPublicationDirectory(relativePath: string): Promise<void> {
    try {
      await this.#serialized(() =>
        this.#paths.refreshDirectoryChainAfterConcurrentEntryChange(relativePath)
      );
    } catch (error) {
      throw normalizeArtifactError(error, "unsafe_state");
    }
  }

  async readBounded(
    relativePath: string,
    maximumBytes: number,
    expectedIdentity?: FileIdentitySnapshot
  ): Promise<Buffer> {
    const handle = await this.openRead(relativePath, "unsafe_state");
    return usingFileHandle(handle, async () => {
      const beforeStatus = await handle.stat();
      assertPrivateArtifactStatus(beforeStatus);
      const before = snapshotFileIdentity(beforeStatus);
      if (before.size > maximumBytes) {
        throw new ArtifactStoreError("integrity_mismatch", "Artifact state is oversized.");
      }
      const bytes = Buffer.alloc(before.size);
      let position = 0;
      while (position < bytes.byteLength) {
        const result = await handle.read(bytes, position, bytes.byteLength - position, position);
        if (result.bytesRead < 1) {
          throw new ArtifactStoreError("integrity_mismatch", "Artifact state was truncated.");
        }
        position += result.bytesRead;
      }
      if ((await handle.read(Buffer.alloc(1), 0, 1, position)).bytesRead !== 0) {
        throw new ArtifactStoreError("integrity_mismatch", "Artifact state grew during reading.");
      }
      const afterStatus = await handle.stat();
      assertPrivateArtifactStatus(afterStatus);
      if (!sameFileIdentity(before, snapshotFileIdentity(afterStatus))) {
        throw new ArtifactStoreError("integrity_mismatch", "Artifact state changed while reading.");
      }
      if (expectedIdentity !== undefined && !sameFileIdentity(expectedIdentity, before)) {
        throw new ArtifactStoreError("integrity_mismatch", "Published artifact state changed.");
      }
      return bytes;
    });
  }

  async #refreshParent(relativePath: string): Promise<void> {
    const separator = relativePath.lastIndexOf("/");
    const parent = separator < 0 ? "." : relativePath.slice(0, separator);
    if (!(await this.#paths.refreshDirectoryChainAfterConcurrentEntryChange(parent))) {
      throw new ArtifactStoreError("unsafe_state", "A private artifact parent is unavailable.");
    }
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#filesystemTail.catch(() => undefined);
    let release!: () => void;
    const gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    this.#filesystemTail = previous.then(() => gate);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
