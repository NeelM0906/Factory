import type { CommandId } from "@autostack/contracts";

import type { ArtifactStoreRecoveryCapability } from "./artifact-mutation-authority.js";
import { validateRecoveredCommand } from "./command-recovery-validation.js";
import { createCommandRegistryError } from "./command-registry-types.js";
import { DataPathPolicy } from "./path-policy.js";
import { canonicalJson, commandComponent } from "./replay-spool-codec.js";
import { inspectCommandPublications } from "./replay-spool-publication-recovery.js";

const requireExistingDirectory = async (
  paths: DataPathPolicy,
  relativePath: string,
  maximumEntries: number
) => {
  const entries = await paths.listExistingDirectory(relativePath, maximumEntries);
  if (entries === undefined) throw createCommandRegistryError("maintenance_required");
  return entries;
};

const admitRecoveryLayout = async (paths: DataPathPolicy, commandRoot: string): Promise<void> => {
  const commandEntries = await requireExistingDirectory(paths, commandRoot, 5);
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
    throw createCommandRegistryError("maintenance_required");
  }
  const spoolEntries = await requireExistingDirectory(paths, `${commandRoot}/spool`, 2);
  if (
    spoolEntries.length !== 2 ||
    !spoolEntries.some((entry) => entry.name === "events" && entry.type === "directory") ||
    !spoolEntries.some((entry) => entry.name === "transcript" && entry.type === "directory")
  ) {
    throw createCommandRegistryError("maintenance_required");
  }
};

export const admitRecoveryPublications = async (
  paths: DataPathPolicy,
  commandId: CommandId,
  artifacts: ArtifactStoreRecoveryCapability
): Promise<void> => {
  const commandRoot = `commands/${commandComponent(commandId)}`;
  await admitRecoveryLayout(paths, commandRoot);
  const candidate = await inspectCommandPublications(paths, commandRoot, commandId);
  await validateRecoveredCommand(candidate);
  const artifactFrame = candidate.events.find((frame) => frame.event.type === "artifact.created");
  if (artifactFrame?.event.type !== "artifact.created") return;
  const committed = await artifacts.findArtifact(artifactFrame.event.artifact.artifactId);
  if (
    committed === undefined ||
    canonicalJson(committed) !== canonicalJson(artifactFrame.event.artifact)
  ) {
    throw createCommandRegistryError("maintenance_required");
  }
};
