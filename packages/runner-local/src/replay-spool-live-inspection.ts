import { ReplaySpoolError } from "./replay-spool-error.js";
import { DataPathPolicy } from "./path-policy.js";

const TEMPORARY_PUBLICATION_PATTERN = /^\.(.+)\.[0-9a-f]{32}\.tmp$/;
const TRANSCRIPT_TEMPORARY_PUBLICATION_PATTERN =
  /^\.(\d{12}\.bin)\.[0-9a-f]{64}\.\d{1,7}\.[0-9a-f]{32}\.tmp$/;

export const requireExistingDirectoryEntries = async (
  paths: DataPathPolicy,
  relativePath: string,
  maximumEntries: number
) => {
  const entries = await paths.listExistingDirectory(relativePath, maximumEntries);
  if (entries === undefined) throw new ReplaySpoolError("maintenance_required");
  return entries;
};

export const validateLiveCommandLayout = async (
  paths: DataPathPolicy,
  commandRoot: string
): Promise<void> => {
  const commandEntries = await requireExistingDirectoryEntries(paths, commandRoot, 5);
  const allowed = new Map<string, "directory" | "file">([
    ["receipt", "directory"],
    ["control", "directory"],
    ["spool", "directory"],
    ["guardian-lease.sqlite3", "file"],
    ["guardian-lease.sqlite3-journal", "file"]
  ]);
  if (
    commandEntries.some((entry) => allowed.get(entry.name) !== entry.type) ||
    ["receipt", "control", "spool"].some(
      (name) => !commandEntries.some((entry) => entry.name === name && entry.type === "directory")
    )
  ) {
    throw new ReplaySpoolError("maintenance_required");
  }
  const spoolEntries = await requireExistingDirectoryEntries(paths, `${commandRoot}/spool`, 2);
  if (
    spoolEntries.length !== 2 ||
    !spoolEntries.some((entry) => entry.name === "events" && entry.type === "directory") ||
    !spoolEntries.some((entry) => entry.name === "transcript" && entry.type === "directory")
  ) {
    throw new ReplaySpoolError("maintenance_required");
  }
};

/** Selects canonical names without reading, promoting, or unlinking crash candidates. */
export const liveCanonicalEntries = <
  Entry extends Readonly<{ readonly name: string; readonly type: string }>
>(
  entries: readonly Entry[],
  accepts: (name: string) => boolean,
  transcript = false
): Entry[] => {
  const canonical: Entry[] = [];
  for (const entry of entries) {
    if (entry.type !== "file") throw new ReplaySpoolError("maintenance_required");
    if (accepts(entry.name)) {
      canonical.push(entry);
      continue;
    }
    const aliasName = transcript
      ? (TRANSCRIPT_TEMPORARY_PUBLICATION_PATTERN.exec(entry.name)?.[1] ??
        TEMPORARY_PUBLICATION_PATTERN.exec(entry.name)?.[1])
      : TEMPORARY_PUBLICATION_PATTERN.exec(entry.name)?.[1];
    if (aliasName === undefined || !accepts(aliasName)) {
      throw new ReplaySpoolError("maintenance_required");
    }
  }
  return canonical;
};
