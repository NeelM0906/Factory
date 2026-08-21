import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { containsSensitiveMaterial } from "@autostack/contracts";

import { fileIdentity, sameFileIdentity, snapshotString } from "./git-client-admission.js";
import { decodeSingleLine } from "./git-client-parsers.js";
import {
  gitError,
  isOwnedGitError,
  type FileIdentity,
  type LocalConfiguration
} from "./git-client-types.js";
import type { ProcessRunResult } from "./process-runner.js";

const MAXIMUM_CONFIG_BYTES = 1024 * 1024;
const MAXIMUM_CONFIG_ENTRIES = 2_048;

const normalizeRemote = (valueInput: string): string => {
  const value = snapshotString(valueInput.trim(), 1_024, "unsafe_remote");
  if (/\p{Cc}/u.test(value) || containsSensitiveMaterial(value)) {
    throw gitError("unsafe_remote");
  }
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(value);
  if (schemeMatch !== null) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw gitError("unsafe_remote");
    }
    if (
      !["https:", "ssh:", "git+ssh:"].includes(url.protocol) ||
      url.password.length > 0 ||
      (url.protocol === "https:" && url.username.length > 0) ||
      ((url.protocol === "ssh:" || url.protocol === "git+ssh:") && url.username !== "git") ||
      url.hostname.length === 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      throw gitError("unsafe_remote");
    }
    return url.toString();
  }
  const scpLike = /^([^/@:]+)@([^/:]+):(.+)$/.exec(value);
  if (scpLike === null || scpLike[1] !== "git") throw gitError("unsafe_remote");
  return value;
};

export const parseConfiguration = (output: string): LocalConfiguration => {
  if (Buffer.byteLength(output) > MAXIMUM_CONFIG_BYTES || output.includes("�")) {
    throw gitError("unsafe_repository");
  }
  const rawRecords = output.split("\0");
  if (rawRecords.at(-1) !== "") throw gitError("malformed_output");
  rawRecords.pop();
  if (rawRecords.length > MAXIMUM_CONFIG_ENTRIES) throw gitError("unsafe_repository");
  const records: Array<readonly [string, string]> = [];
  for (const record of rawRecords) {
    const separator = record.indexOf("\n");
    if (separator < 1) throw gitError("malformed_output");
    const key = record.slice(0, separator);
    const value = record.slice(separator + 1);
    if (key.length > 1_024 || value.length > 8_192 || key.includes("\n") || value.includes("\0")) {
      throw gitError("unsafe_repository");
    }
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey.startsWith("include.") ||
      normalizedKey.startsWith("includeif.") ||
      normalizedKey === "core.hookspath" ||
      normalizedKey === "core.fsmonitor" ||
      normalizedKey === "core.attributesfile" ||
      normalizedKey === "core.sshcommand" ||
      normalizedKey === "core.askpass" ||
      normalizedKey === "extensions.worktreeconfig" ||
      normalizedKey === "extensions.partialclone" ||
      normalizedKey === "protocol.allow" ||
      /^protocol\..+\.allow$/.test(normalizedKey) ||
      /^credential(?:\.|$)/.test(normalizedKey) ||
      /^remote\..+\.(?:promisor|partialclonefilter|uploadpack|receivepack|vcs)$/.test(
        normalizedKey
      ) ||
      /^url\..+\.(?:insteadof|pushinsteadof)$/.test(normalizedKey) ||
      /^submodule\..+\.update$/.test(normalizedKey) ||
      /^filter\..+\.(?:clean|smudge|process)$/.test(normalizedKey)
    ) {
      throw gitError("unsafe_repository");
    }
    records.push(Object.freeze([key, value] as const));
  }
  const remoteValues = records
    .filter(([key]) => /^remote\..+\.(?:url|pushurl)$/i.test(key))
    .map(([, value]) => normalizeRemote(value));
  const originValues = records
    .filter(([key]) => /^remote\.origin\.url$/i.test(key))
    .map(([, value]) => normalizeRemote(value));
  if (originValues.length > 1) throw gitError("unsafe_repository");
  // Force validation of every remote, including non-origin push URLs.
  void remoteValues;
  const digest = createHash("sha256").update(JSON.stringify(records)).digest("hex");
  const remoteIdentity = originValues[0];
  return Object.freeze({
    digest,
    ...(remoteIdentity === undefined ? {} : { remoteIdentity })
  });
};

const localConfigurationFile = async (
  sourcePath: string,
  runGit: (args: readonly string[]) => Promise<ProcessRunResult>
): Promise<{ readonly path: string; readonly identity: FileIdentity }> => {
  try {
    const result = await runGit([
      "-C",
      sourcePath,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "config"
    ]);
    if (result.exitCode !== 0 || result.signal !== null) throw gitError("invalid_repository");
    const requested = decodeSingleLine(result.stdout);
    if (!isAbsolute(requested)) throw gitError("unsafe_repository");
    const canonical = await realpath(requested);
    const status = await lstat(canonical);
    if (canonical !== requested || status.isSymbolicLink() || !status.isFile()) {
      throw gitError("unsafe_repository");
    }
    return Object.freeze({ path: canonical, identity: fileIdentity(status) });
  } catch (error) {
    if (isOwnedGitError(error)) throw error;
    throw gitError("unsafe_repository");
  }
};

export const readStableLocalConfiguration = async (
  sourcePath: string,
  runGit: (args: readonly string[]) => Promise<ProcessRunResult>
): Promise<LocalConfiguration> => {
  const before = await localConfigurationFile(sourcePath, runGit);
  const result = await runGit([
    "-C",
    sourcePath,
    "config",
    "--local",
    "--null",
    "--list",
    "--no-includes"
  ]);
  if (result.exitCode !== 0) throw gitError("invalid_repository");
  const after = await localConfigurationFile(sourcePath, runGit);
  if (after.path !== before.path || !sameFileIdentity(after.identity, before.identity)) {
    throw gitError("unsafe_repository");
  }
  return parseConfiguration(result.stdout);
};
