import { constants as fsConstants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { EnvironmentId } from "@autostack/contracts";

import { ArtifactFiles } from "./artifact-files.js";
import { writeAll } from "./artifact-io.js";
import { OwnedEnvironmentRegistryError } from "./environment-registry-errors.js";
import {
  ATTEMPT_PATTERN,
  MAXIMUM_ENVIRONMENTS,
  MAXIMUM_ENVIRONMENT_ROOT_ENTRIES,
  MAXIMUM_EVIDENCE_BYTES,
  MAXIMUM_INTENT_BYTES,
  PHASES,
  encodeRecord,
  environmentIdComponent,
  isRecord,
  phaseRelative
} from "./environment-registry-records.js";
import { usingFileHandle } from "./file-handle-lifecycle.js";
import type { ConfinedDirectoryEntry } from "./path-policy.js";
import { DataPathPolicy } from "./path-policy.js";
import {
  assertPrivateDirectory,
  assertPrivateFileLinkCount,
  identityOf,
  isWithin,
  samePinnedIdentity,
  type PathIdentity
} from "./path-security.js";

const NO_FOLLOW_OPEN_FLAG = process.platform === "darwin" ? 0x2000_0000 : fsConstants.O_NOFOLLOW;

const PUBLICATION_RECORDS = Object.freeze([
  "intent",
  "intent_recorded",
  "worktree_added",
  "ready",
  "disposal_recorded",
  "disposed"
] as const);
const PUBLICATION_STEPS = Object.freeze([
  "temp-synced",
  "temp-directory-synced",
  "canonical-linked",
  "canonical-directory-synced",
  "alias-unlinked",
  "alias-directory-synced"
] as const);
export type EnvironmentRegistryPublicationRecord = (typeof PUBLICATION_RECORDS)[number];
type EnvironmentRegistryPublicationStep = (typeof PUBLICATION_STEPS)[number];
export type EnvironmentRegistryPublicationBoundary =
  `${EnvironmentRegistryPublicationRecord}.${EnvironmentRegistryPublicationStep}`;
export const ENVIRONMENT_REGISTRY_PUBLICATION_BOUNDARIES = Object.freeze(
  PUBLICATION_RECORDS.flatMap((record) =>
    PUBLICATION_STEPS.map((step) => `${record}.${step}` as EnvironmentRegistryPublicationBoundary)
  )
);

export class EnvironmentRegistryPublications {
  readonly #paths: DataPathPolicy;
  readonly #files: ArtifactFiles;
  readonly #onBoundary: (boundary: EnvironmentRegistryPublicationBoundary) => unknown;

  constructor(
    paths: DataPathPolicy,
    onBoundary: (boundary: EnvironmentRegistryPublicationBoundary) => unknown
  ) {
    this.#paths = paths;
    this.#files = new ArtifactFiles(paths);
    this.#onBoundary = onBoundary;
  }

  async writeImmutable(
    relativePath: string,
    value: object,
    record: EnvironmentRegistryPublicationRecord,
    attemptId: string
  ): Promise<void> {
    const bytes = encodeRecord(value);
    this.assertPublicationSize(value, record);
    const { parent, fileName } = this.#splitRelative(relativePath);
    const tempRelative = `${parent}/.${fileName}.${record}.${attemptId}.tmp`;
    let entries = await this.#listPublicationDirectory(parent);
    let canonical = entries.find((entry) => entry.name === fileName);
    let temp = entries.find((entry) => entry.name === `.${fileName}.${record}.${attemptId}.tmp`);
    const relatedTemps = entries.filter(
      (entry) => entry.name.startsWith(`.${fileName}.${record}.`) && entry.name.endsWith(".tmp")
    );
    if (relatedTemps.length > (temp === undefined ? 0 : 1)) {
      throw new OwnedEnvironmentRegistryError("maintenance_required");
    }
    if (canonical !== undefined && temp === undefined) {
      if (canonical.type !== "file" || canonical.identity.nlink !== 1) {
        throw new OwnedEnvironmentRegistryError("unsafe_state");
      }
      if (!(await this.#files.readBounded(relativePath, bytes.byteLength)).equals(bytes)) {
        throw new OwnedEnvironmentRegistryError("conflicting_record");
      }
      await this.#files.syncDirectory(parent);
      return;
    }
    if (canonical !== undefined && temp !== undefined) {
      if (
        canonical.type !== "file" ||
        temp.type !== "file" ||
        canonical.identity.nlink !== 2 ||
        temp.identity.nlink !== 2 ||
        canonical.identity.dev !== temp.identity.dev ||
        canonical.identity.ino !== temp.identity.ino
      ) {
        throw new OwnedEnvironmentRegistryError("maintenance_required");
      }
      if (
        !(await this.#readLinkedBytes(tempRelative, temp.identity, bytes.byteLength)).equals(bytes)
      ) {
        throw new OwnedEnvironmentRegistryError("conflicting_record");
      }
      await this.#files.syncDirectory(parent);
      await this.#boundary(record, "canonical-directory-synced");
      const healed = await this.#files.healLinkedAlias(tempRelative, relativePath, () =>
        this.#boundary(record, "alias-unlinked")
      );
      if (!healed) throw new OwnedEnvironmentRegistryError("maintenance_required");
      await this.#boundary(record, "alias-directory-synced");
      if (!(await this.#files.readBounded(relativePath, bytes.byteLength)).equals(bytes)) {
        throw new OwnedEnvironmentRegistryError("conflicting_record");
      }
      return;
    }
    if (canonical === undefined && temp !== undefined) {
      if (temp.type !== "file" || temp.identity.nlink !== 1) {
        throw new OwnedEnvironmentRegistryError("maintenance_required");
      }
      if (!(await this.#files.readBounded(tempRelative, bytes.byteLength)).equals(bytes)) {
        throw new OwnedEnvironmentRegistryError("maintenance_required");
      }
      await this.#files.syncDirectory(parent);
      await this.#boundary(record, "temp-directory-synced");
    } else {
      const handle = await this.#files.create(tempRelative);
      await usingFileHandle(handle, async () => {
        await writeAll(handle, bytes, 0);
        await handle.sync();
      });
      await this.#boundary(record, "temp-synced");
      await this.#files.syncDirectory(parent);
      await this.#boundary(record, "temp-directory-synced");
    }
    if (!(await this.#files.linkNoReplace(tempRelative, relativePath))) {
      throw new OwnedEnvironmentRegistryError("maintenance_required");
    }
    await this.#boundary(record, "canonical-linked");
    await this.#files.syncDirectory(parent);
    await this.#boundary(record, "canonical-directory-synced");
    const healed = await this.#files.healLinkedAlias(tempRelative, relativePath, () =>
      this.#boundary(record, "alias-unlinked")
    );
    if (!healed) throw new OwnedEnvironmentRegistryError("maintenance_required");
    await this.#boundary(record, "alias-directory-synced");
    entries = await this.#listPublicationDirectory(parent);
    canonical = entries.find((entry) => entry.name === fileName);
    temp = entries.find((entry) => entry.name === `.${fileName}.${record}.${attemptId}.tmp`);
    if (
      canonical?.type !== "file" ||
      canonical.identity.nlink !== 1 ||
      temp !== undefined ||
      !(await this.#files.readBounded(relativePath, bytes.byteLength)).equals(bytes)
    ) {
      throw new OwnedEnvironmentRegistryError("maintenance_required");
    }
  }

  assertPublicationSize(value: object, record: EnvironmentRegistryPublicationRecord): void {
    const maximumBytes = record === "intent" ? MAXIMUM_INTENT_BYTES : MAXIMUM_EVIDENCE_BYTES;
    if (encodeRecord(value).byteLength > maximumBytes) {
      throw new OwnedEnvironmentRegistryError("invalid_input");
    }
  }

  async readPublication<T extends { readonly creationAttemptId: string }>(
    relativePath: string,
    maximumBytes: number,
    record: EnvironmentRegistryPublicationRecord,
    parse: (value: unknown) => T,
    validateContext: (value: T) => boolean
  ): Promise<T | undefined> {
    const { parent, fileName } = this.#splitRelative(relativePath);
    const entries = await this.#listPublicationDirectory(parent);
    const canonical = entries.find((entry) => entry.name === fileName);
    const prefix = `.${fileName}.${record}.`;
    const temps = entries.filter(
      (entry) => entry.name.startsWith(prefix) && entry.name.endsWith(".tmp")
    );
    if (temps.length > 1) throw new OwnedEnvironmentRegistryError("maintenance_required");
    const temp = temps[0];
    if (canonical === undefined && temp === undefined) return undefined;
    if (canonical !== undefined && temp !== undefined) {
      if (
        canonical.type !== "file" ||
        temp.type !== "file" ||
        canonical.identity.nlink !== 2 ||
        temp.identity.nlink !== 2 ||
        canonical.identity.dev !== temp.identity.dev ||
        canonical.identity.ino !== temp.identity.ino
      ) {
        throw new OwnedEnvironmentRegistryError("maintenance_required");
      }
      const tempRelative = `${parent}/${temp.name}`;
      const attemptFromName = temp.name.slice(prefix.length, -".tmp".length);
      if (!ATTEMPT_PATTERN.test(attemptFromName)) {
        throw new OwnedEnvironmentRegistryError("maintenance_required");
      }
      const parsed = this.#decodeRecord(
        await this.#readLinkedBytes(tempRelative, temp.identity, maximumBytes),
        parse
      );
      if (parsed.creationAttemptId !== attemptFromName) {
        throw new OwnedEnvironmentRegistryError("maintenance_required");
      }
      this.#assertPublicationContext(parsed, validateContext);
      const healed = await this.#files.healLinkedAlias(tempRelative, relativePath, () =>
        this.#boundary(record, "alias-unlinked")
      );
      if (!healed) throw new OwnedEnvironmentRegistryError("maintenance_required");
      await this.#boundary(record, "alias-directory-synced");
      await this.#files.syncDirectory(parent);
      const published = await this.#readRecord(relativePath, maximumBytes, parse);
      this.#assertPublicationContext(published, validateContext);
      return published;
    }
    if (canonical !== undefined) {
      if (canonical.type !== "file" || canonical.identity.nlink !== 1) {
        throw new OwnedEnvironmentRegistryError("unsafe_state");
      }
      await this.#files.syncDirectory(parent);
      const parsed = await this.#readRecord(relativePath, maximumBytes, parse);
      this.#assertPublicationContext(parsed, validateContext);
      return parsed;
    }
    if (temp?.type !== "file" || temp.identity.nlink !== 1) {
      throw new OwnedEnvironmentRegistryError("maintenance_required");
    }
    const attemptFromName = temp.name.slice(prefix.length, -".tmp".length);
    if (!ATTEMPT_PATTERN.test(attemptFromName)) {
      throw new OwnedEnvironmentRegistryError("maintenance_required");
    }
    const parsed = await this.#readRecord(`${parent}/${temp.name}`, maximumBytes, parse);
    if (parsed.creationAttemptId !== attemptFromName) {
      throw new OwnedEnvironmentRegistryError("maintenance_required");
    }
    this.#assertPublicationContext(parsed, validateContext);
    await this.writeImmutable(relativePath, parsed, record, attemptFromName);
    const published = await this.#readRecord(relativePath, maximumBytes, parse);
    this.#assertPublicationContext(published, validateContext);
    return published;
  }

  async validateEnvironmentJournal(environmentId: EnvironmentId): Promise<void> {
    const directory = `environments/journal/${environmentIdComponent(environmentId)}`;
    const entries = await this.listDirectoryBounded(directory, PHASES.length * 2);
    if (entries.length > PHASES.length * 2) {
      throw new OwnedEnvironmentRegistryError("maintenance_required");
    }
    const allowed = new Set<string>();
    for (const phase of PHASES) {
      const canonicalName = this.#splitRelative(
        phaseRelative(environmentId, phase.sequence)
      ).fileName;
      allowed.add(canonicalName);
      for (const entry of entries) {
        if (
          entry.type === "file" &&
          entry.name.startsWith(`.${canonicalName}.${phase.phase}.`) &&
          /^\.[^.]+\.json\.[a-z_]+\.[0-9a-f]{32}\.tmp$/.test(entry.name)
        ) {
          allowed.add(entry.name);
        }
      }
    }
    if (entries.some((entry) => !allowed.has(entry.name))) {
      throw new OwnedEnvironmentRegistryError("maintenance_required");
    }
  }

  async listDirectoryBounded(
    relativePath: string,
    maximumEntries: number
  ): Promise<readonly ConfinedDirectoryEntry[]> {
    const directory = await this.#paths.ensureDirectory(relativePath);
    const beforeStatus = await lstat(directory);
    assertPrivateDirectory(beforeStatus);
    const before = identityOf(beforeStatus);
    if ((await realpath(directory)) !== directory) {
      throw new OwnedEnvironmentRegistryError("unsafe_state");
    }
    const firstNames = await this.#readDirectoryNamesBounded(directory, maximumEntries);
    const secondNames = await this.#readDirectoryNamesBounded(directory, maximumEntries);
    if (
      firstNames.length !== secondNames.length ||
      firstNames.some((name, index) => name !== secondNames[index])
    ) {
      throw new OwnedEnvironmentRegistryError("unsafe_state");
    }
    const entries: ConfinedDirectoryEntry[] = [];
    const identities = new Map<string, PathIdentity>();
    for (const name of firstNames) {
      const entryPath = resolve(directory, name);
      if (!isWithin(directory, entryPath)) {
        throw new OwnedEnvironmentRegistryError("unsafe_state");
      }
      const status = await lstat(entryPath);
      if (status.isDirectory() && !status.isSymbolicLink()) {
        assertPrivateDirectory(status);
        const identity = identityOf(status);
        identities.set(name, identity);
        entries.push({ name, type: "directory", identity });
      } else if (status.isFile() && !status.isSymbolicLink()) {
        if (status.nlink !== 1 && status.nlink !== 2) {
          throw new OwnedEnvironmentRegistryError("unsafe_state");
        }
        assertPrivateFileLinkCount(status, status.nlink);
        const identity = identityOf(status);
        identities.set(name, identity);
        entries.push({ name, type: "file", identity });
      } else {
        throw new OwnedEnvironmentRegistryError("unsafe_state");
      }
    }
    for (const name of firstNames) {
      const expected = identities.get(name);
      if (expected === undefined) throw new OwnedEnvironmentRegistryError("unsafe_state");
      const status = await lstat(resolve(directory, name));
      if (status.isDirectory()) assertPrivateDirectory(status);
      else {
        if (status.nlink !== 1 && status.nlink !== 2) {
          throw new OwnedEnvironmentRegistryError("unsafe_state");
        }
        assertPrivateFileLinkCount(status, status.nlink);
      }
      if (!samePinnedIdentity(expected, identityOf(status))) {
        throw new OwnedEnvironmentRegistryError("unsafe_state");
      }
    }
    const afterStatus = await lstat(directory);
    assertPrivateDirectory(afterStatus);
    if (
      !samePinnedIdentity(before, identityOf(afterStatus)) ||
      (await realpath(directory)) !== directory
    ) {
      throw new OwnedEnvironmentRegistryError("unsafe_state");
    }
    return entries;
  }

  #assertPublicationContext<T>(value: T, validateContext: (value: T) => boolean): void {
    let valid = false;
    try {
      valid = validateContext(value);
    } catch {
      valid = false;
    }
    if (!valid) throw new OwnedEnvironmentRegistryError("maintenance_required");
  }

  async #readRecord<T>(
    relativePath: string,
    maximumBytes: number,
    parse: (value: unknown) => T
  ): Promise<T> {
    const bytes = await this.#files.readBounded(relativePath, maximumBytes);
    return this.#decodeRecord(bytes, parse);
  }

  #decodeRecord<T>(bytes: Buffer, parse: (value: unknown) => T): T {
    if (bytes.byteLength < 2) throw new OwnedEnvironmentRegistryError("maintenance_required");
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new OwnedEnvironmentRegistryError("maintenance_required");
    }
    if (!isRecord(parsed) || !encodeRecord(parsed).equals(bytes)) {
      throw new OwnedEnvironmentRegistryError("maintenance_required");
    }
    const admitted = parse(parsed);
    if (
      typeof admitted !== "object" ||
      admitted === null ||
      !encodeRecord(admitted).equals(bytes)
    ) {
      throw new OwnedEnvironmentRegistryError("maintenance_required");
    }
    return admitted;
  }

  async #readLinkedBytes(
    relativePath: string,
    expectedIdentity: PathIdentity,
    maximumBytes: number
  ): Promise<Buffer> {
    const absolutePath = resolve(this.#paths.root, relativePath);
    if (!isWithin(this.#paths.root, absolutePath)) {
      throw new OwnedEnvironmentRegistryError("unsafe_state");
    }
    const handle = await open(absolutePath, fsConstants.O_RDONLY | NO_FOLLOW_OPEN_FLAG);
    return usingFileHandle(handle, async () => {
      const before = await handle.stat();
      assertPrivateFileLinkCount(before, 2);
      if (
        !samePinnedIdentity(expectedIdentity, identityOf(before)) ||
        !Number.isSafeInteger(before.size) ||
        before.size < 0 ||
        before.size > maximumBytes
      ) {
        throw new OwnedEnvironmentRegistryError("maintenance_required");
      }
      const bytes = Buffer.alloc(before.size);
      let position = 0;
      while (position < bytes.byteLength) {
        const { bytesRead } = await handle.read(
          bytes,
          position,
          bytes.byteLength - position,
          position
        );
        if (bytesRead < 1) throw new OwnedEnvironmentRegistryError("maintenance_required");
        position += bytesRead;
      }
      if ((await handle.read(Buffer.alloc(1), 0, 1, position)).bytesRead !== 0) {
        throw new OwnedEnvironmentRegistryError("maintenance_required");
      }
      const after = await handle.stat();
      assertPrivateFileLinkCount(after, 2);
      const pathAfter = await lstat(absolutePath);
      assertPrivateFileLinkCount(pathAfter, 2);
      if (
        !samePinnedIdentity(identityOf(before), identityOf(after)) ||
        !samePinnedIdentity(identityOf(after), identityOf(pathAfter)) ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        after.size !== pathAfter.size ||
        after.mtimeMs !== pathAfter.mtimeMs ||
        after.ctimeMs !== pathAfter.ctimeMs
      ) {
        throw new OwnedEnvironmentRegistryError("maintenance_required");
      }
      return bytes;
    });
  }

  async #listPublicationDirectory(
    relativePath: string
  ): Promise<readonly ConfinedDirectoryEntry[]> {
    const maximumEntries =
      relativePath === "environments"
        ? MAXIMUM_ENVIRONMENT_ROOT_ENTRIES
        : relativePath === "environments/journal"
          ? MAXIMUM_ENVIRONMENTS
          : PHASES.length * 2;
    return this.listDirectoryBounded(relativePath, maximumEntries);
  }

  async #readDirectoryNamesBounded(
    directoryPath: string,
    maximumEntries: number
  ): Promise<readonly string[]> {
    const directory = await opendir(directoryPath);
    const names: string[] = [];
    for await (const entry of directory) {
      if (names.length >= maximumEntries) {
        throw new OwnedEnvironmentRegistryError("maintenance_required");
      }
      names.push(entry.name);
    }
    return names.sort();
  }

  #splitRelative(relativePath: string): { readonly parent: string; readonly fileName: string } {
    const slash = relativePath.lastIndexOf("/");
    if (slash < 1 || slash === relativePath.length - 1) {
      throw new OwnedEnvironmentRegistryError("unsafe_state");
    }
    return { parent: relativePath.slice(0, slash), fileName: relativePath.slice(slash + 1) };
  }

  async #boundary(
    record: EnvironmentRegistryPublicationRecord,
    step: EnvironmentRegistryPublicationStep
  ): Promise<void> {
    await this.#onBoundary(`${record}.${step}`);
  }
}
