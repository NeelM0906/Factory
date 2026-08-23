import { ArtifactStoreError } from "./artifact-types.js";
import { KeyedLock } from "./keyed-lock.js";
import type { DataPathPolicy } from "./path-policy.js";

const ARTIFACT_DIRECTORIES = Object.freeze(["sha256", "metadata", "tmp", "transactions"]);
const initializationLocks = new KeyedLock();

/** Initializes a new store, but never heals a partially existing recovery topology. */
export const initializeOrAdmitArtifactTopology = async (paths: DataPathPolicy): Promise<void> =>
  await initializationLocks.run(paths.root, async () => {
    const expected = new Set(ARTIFACT_DIRECTORIES);
    const entries = await paths.listExistingDirectory("artifacts", expected.size);
    if (entries === undefined) {
      await paths.ensureDirectory("artifacts");
      for (const name of expected) await paths.ensureDirectory(`artifacts/${name}`);
      return;
    }
    if (
      entries.length !== expected.size ||
      entries.some((entry) => entry.type !== "directory" || !expected.delete(entry.name)) ||
      expected.size !== 0
    ) {
      throw new ArtifactStoreError("unsafe_state", "Artifact recovery topology is unavailable.");
    }
  });
