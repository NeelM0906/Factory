import type { FileHandle } from "node:fs/promises";

import { ArtifactStoreError, STATIC_ERROR_MESSAGES } from "./artifact-types.js";

const closeHandle = async (handle: FileHandle, primaryFailed: boolean): Promise<void> => {
  let closeFailed = false;
  try {
    await handle.close();
  } catch {
    closeFailed = true;
    try {
      await handle.close();
    } catch {
      // A second close is best effort and is always observed.
    }
  }
  if (closeFailed && !primaryFailed) {
    throw new ArtifactStoreError("filesystem_error", STATIC_ERROR_MESSAGES.filesystem_error);
  }
};

/** Closes a handle without replacing a primary failure or hiding a success-path close failure. */
export const usingFileHandle = async <T>(
  handle: FileHandle,
  operation: (handle: FileHandle) => Promise<T>
): Promise<T> => {
  let result!: T;
  let primaryError: unknown;
  let primaryFailed = false;
  try {
    result = await operation(handle);
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  }
  await closeHandle(handle, primaryFailed);
  if (primaryFailed) throw primaryError;
  return result;
};

export const closeFileHandleAfterFailure = async (handle: FileHandle): Promise<void> => {
  await closeHandle(handle, true);
};
