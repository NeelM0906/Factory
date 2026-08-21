import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import {
  DARWIN_DIRECTORY_OPEN_FLAGS,
  assertPrivateDirectory,
  identityOf,
  sameIdentityExceptLinkCount,
  sameObject,
  samePinnedIdentity,
  type PathIdentity
} from "./path-security.js";
import { OwnedPathPolicyError as PathPolicyError } from "./path-types.js";

/** Tracks stable directory capabilities while admitting entry-count drift between store brokers. */
export class PinnedDirectories {
  readonly #root: string;
  readonly #pins = new Map<string, PathIdentity>();

  constructor(root: string, rootIdentity: PathIdentity) {
    this.#root = root;
    this.#pins.set(root, rootIdentity);
  }

  has(path: string): boolean {
    return this.#pins.has(path);
  }

  expected(path: string): PathIdentity | undefined {
    return this.#pins.get(path);
  }

  set(path: string, identity: PathIdentity): void {
    this.#pins.set(path, identity);
  }

  async validate(path: string): Promise<PathIdentity> {
    const expected = this.#require(path);
    let status: Stats;
    try {
      status = await lstat(path);
    } catch {
      throw new PathPolicyError("path_identity_changed", "A pinned state path disappeared.");
    }
    const actual = identityOf(status);
    if (!sameObject(expected, actual) || status.isSymbolicLink() || !status.isDirectory()) {
      throw new PathPolicyError("path_identity_changed", "A pinned state directory changed.");
    }
    if (actual.uid !== expected.uid || actual.mode !== expected.mode) {
      throw new PathPolicyError(
        "unsafe_permissions",
        "Pinned state-directory permissions changed."
      );
    }
    if (actual.nlink !== expected.nlink) {
      throw new PathPolicyError("path_identity_changed", "A pinned state directory changed.");
    }
    assertPrivateDirectory(status);
    if ((await realpath(path)) !== path) {
      throw new PathPolicyError("path_identity_changed", "A pinned state path was redirected.");
    }
    return actual;
  }

  async validateAllowingConcurrentEntries(path: string): Promise<PathIdentity> {
    const expected = this.#require(path);
    let status: Stats;
    try {
      status = await lstat(path);
    } catch {
      throw new PathPolicyError("path_identity_changed", "A pinned state path disappeared.");
    }
    const actual = identityOf(status);
    if (status.isSymbolicLink() || !status.isDirectory() || !sameObject(expected, actual)) {
      throw new PathPolicyError("path_identity_changed", "A pinned state directory changed.");
    }
    assertPrivateDirectory(status);
    if (actual.uid !== expected.uid || actual.mode !== expected.mode) {
      throw new PathPolicyError(
        "unsafe_permissions",
        "Pinned state-directory permissions changed."
      );
    }
    if ((await realpath(path)) !== path) {
      throw new PathPolicyError("path_identity_changed", "A pinned state directory changed.");
    }
    this.#pins.set(path, actual);
    return actual;
  }

  async pinExisting(path: string): Promise<PathIdentity> {
    const firstStatus = await lstat(path);
    assertPrivateDirectory(firstStatus);
    const first = identityOf(firstStatus);
    if ((await realpath(path)) !== path) {
      throw new PathPolicyError("path_identity_changed", "A state directory was redirected.");
    }
    const secondStatus = await lstat(path);
    assertPrivateDirectory(secondStatus);
    const second = identityOf(secondStatus);
    if (!samePinnedIdentity(first, second)) {
      throw new PathPolicyError("path_identity_changed", "A state directory changed while pinned.");
    }
    this.#pins.set(path, second);
    return second;
  }

  async validateChain(segments: readonly string[], allowEntryDrift = false): Promise<void> {
    let current = this.#root;
    const validate = allowEntryDrift
      ? this.validateAllowingConcurrentEntries.bind(this)
      : this.validate.bind(this);
    await validate(current);
    for (const segment of segments) {
      current = resolve(current, segment);
      await validate(current);
    }
  }

  async syncAllowingConcurrentEntries(path: string): Promise<void> {
    const expected = await this.validateAllowingConcurrentEntries(path);
    const handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | DARWIN_DIRECTORY_OPEN_FLAGS
    );
    try {
      const openedStatus = await handle.stat();
      assertPrivateDirectory(openedStatus);
      const opened = identityOf(openedStatus);
      if (!sameIdentityExceptLinkCount(expected, opened)) {
        throw new PathPolicyError("path_identity_changed", "A directory changed during sync.");
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.validateAllowingConcurrentEntries(path);
  }

  #require(path: string): PathIdentity {
    const expected = this.#pins.get(path);
    if (expected === undefined) {
      throw new PathPolicyError("path_identity_changed", "An unpinned state directory was used.");
    }
    return expected;
  }
}
