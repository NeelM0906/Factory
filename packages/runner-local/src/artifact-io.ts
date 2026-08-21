import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

import { StreamingSensitiveScanner } from "./redacted-transcript.js";

export const ARTIFACT_STREAM_BUFFER_BYTES = 64 * 1_024;

export interface FileIdentitySnapshot {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface InspectedArtifactFile {
  readonly digest: string;
  readonly byteSize: number;
  readonly sensitiveDetected: boolean;
  readonly selectedBytes: Buffer;
  readonly identity: FileIdentitySnapshot;
}

export const snapshotFileIdentity = (status: Stats): FileIdentitySnapshot => ({
  dev: status.dev,
  ino: status.ino,
  uid: status.uid,
  mode: status.mode & 0o7777,
  nlink: status.nlink,
  size: status.size,
  mtimeMs: status.mtimeMs,
  ctimeMs: status.ctimeMs
});

export const sameFileIdentity = (
  left: FileIdentitySnapshot,
  right: FileIdentitySnapshot
): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.uid === right.uid &&
  left.mode === right.mode &&
  left.nlink === right.nlink &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

export const writeAll = async (
  handle: FileHandle,
  chunk: Uint8Array,
  position: number
): Promise<number> => {
  let written = 0;
  while (written < chunk.byteLength) {
    const result = await handle.write(
      chunk,
      written,
      chunk.byteLength - written,
      position + written
    );
    if (result.bytesWritten < 1) throw new Error("A bounded artifact write made no progress.");
    written += result.bytesWritten;
  }
  return position + written;
};

export const inspectArtifactHandle = async (
  handle: FileHandle,
  sensitiveValues: readonly string[] = [],
  selection?: { readonly offset: number; readonly length: number },
  expectedByteSize?: number
): Promise<InspectedArtifactFile> => {
  const beforeStatus = await handle.stat();
  assertPrivateArtifactStatus(beforeStatus);
  const before = snapshotFileIdentity(beforeStatus);
  if (
    !Number.isSafeInteger(before.size) ||
    before.size < 0 ||
    (expectedByteSize !== undefined && before.size !== expectedByteSize)
  ) {
    throw new Error("The artifact inode size disagrees with its descriptor.");
  }
  const digest = createHash("sha256");
  const scanner = new StreamingSensitiveScanner(sensitiveValues);
  const selected: Buffer[] = [];
  const selectionStart = selection?.offset ?? 0;
  const selectionEnd = selection === undefined ? 0 : selection.offset + selection.length;
  const buffer = Buffer.alloc(ARTIFACT_STREAM_BUFFER_BYTES);
  let position = 0;
  while (position < before.size) {
    const requested = Math.min(buffer.byteLength, before.size - position);
    const { bytesRead } = await handle.read(buffer, 0, requested, position);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 1 || bytesRead > requested) {
      throw new Error("The artifact inode returned an invalid bounded read.");
    }
    const chunk = buffer.subarray(0, bytesRead);
    digest.update(chunk);
    scanner.write(chunk);
    const chunkEnd = position + bytesRead;
    if (selection !== undefined && chunkEnd > selectionStart && position < selectionEnd) {
      const from = Math.max(0, selectionStart - position);
      const to = Math.min(bytesRead, selectionEnd - position);
      selected.push(Buffer.from(chunk.subarray(from, to)));
    }
    position = chunkEnd;
  }
  const eofGuard = Buffer.alloc(1);
  const { bytesRead: eofBytesRead } = await handle.read(eofGuard, 0, 1, position);
  const afterStatus = await handle.stat();
  assertPrivateArtifactStatus(afterStatus);
  const after = snapshotFileIdentity(afterStatus);
  if (
    eofBytesRead !== 0 ||
    !sameFileIdentity(before, after) ||
    position !== before.size ||
    (expectedByteSize !== undefined && position !== expectedByteSize)
  ) {
    throw new Error("The artifact inode changed during verification.");
  }
  return {
    digest: digest.digest("hex"),
    byteSize: position,
    sensitiveDetected: scanner.finalize(),
    selectedBytes: Buffer.concat(selected),
    identity: after
  };
};

export const artifactHandlesHaveEqualBytes = async (
  left: FileHandle,
  right: FileHandle
): Promise<boolean> => {
  const leftBeforeStatus = await left.stat();
  const rightBeforeStatus = await right.stat();
  assertPrivateArtifactStatus(leftBeforeStatus);
  assertPrivateArtifactStatus(rightBeforeStatus);
  const leftBefore = snapshotFileIdentity(leftBeforeStatus);
  const rightBefore = snapshotFileIdentity(rightBeforeStatus);
  if (leftBefore.size !== rightBefore.size) return false;
  const leftBuffer = Buffer.alloc(ARTIFACT_STREAM_BUFFER_BYTES);
  const rightBuffer = Buffer.alloc(ARTIFACT_STREAM_BUFFER_BYTES);
  let position = 0;
  let equal = true;
  while (position < leftBefore.size) {
    const length = Math.min(leftBuffer.byteLength, leftBefore.size - position);
    const [leftRead, rightRead] = await Promise.all([
      left.read(leftBuffer, 0, length, position),
      right.read(rightBuffer, 0, length, position)
    ]);
    if (leftRead.bytesRead !== length || rightRead.bytesRead !== length) {
      throw new Error("An artifact inode changed during exact comparison.");
    }
    if (!leftBuffer.subarray(0, length).equals(rightBuffer.subarray(0, length))) equal = false;
    position += length;
  }
  const leftAfterStatus = await left.stat();
  const rightAfterStatus = await right.stat();
  assertPrivateArtifactStatus(leftAfterStatus);
  assertPrivateArtifactStatus(rightAfterStatus);
  if (
    !sameFileIdentity(leftBefore, snapshotFileIdentity(leftAfterStatus)) ||
    !sameFileIdentity(rightBefore, snapshotFileIdentity(rightAfterStatus))
  ) {
    throw new Error("An artifact inode changed during exact comparison.");
  }
  return equal;
};

export const assertPrivateArtifactStatus = (status: Stats): void => {
  const effectiveUid = process.geteuid?.() ?? process.getuid?.();
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    (status.mode & 0o7777) !== 0o600 ||
    (effectiveUid !== undefined && status.uid !== effectiveUid)
  ) {
    throw new Error("The artifact inode is not a private single-link regular file.");
  }
};
