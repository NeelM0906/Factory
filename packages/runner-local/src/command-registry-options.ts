import type { ArtifactStoreRecoveryCapability } from "./artifact-mutation-authority.js";
import {
  admitArtifactStoreRecoveryCapability,
  admitArtifactStoreRecoveryRoot
} from "./artifact-mutation-authority.js";
import { ArtifactStore } from "./artifact-store.js";
import {
  createCommandRegistryError,
  type CommandRegistryOptions
} from "./command-registry-types.js";
import { DataPathPolicy } from "./path-policy.js";

const MAXIMUM_COMMANDS = 10_000;
const MAXIMUM_COMMAND_SUBSCRIBERS = 256;
const MAXIMUM_SUBSCRIBERS = 4_096;

export interface AdmittedCommandRegistryOptions {
  readonly dataRoot: string;
  readonly artifactStore: ArtifactStore;
  readonly artifactCapability: ArtifactStoreRecoveryCapability;
  readonly queueFrames: number;
  readonly queueBytes: number;
  readonly maximumCommands: number;
  readonly maximumCommandSubscribers: number;
  readonly maximumSubscribers: number;
  readonly subscriberIdleMs: number;
}

export const admitCommandRegistryOptions = async (
  options: CommandRegistryOptions
): Promise<AdmittedCommandRegistryOptions> => {
  try {
    const dataRoot = options.dataRoot;
    const queueFrames = options.subscriberQueueFrames ?? 64;
    const queueBytes = options.subscriberQueueBytes ?? 1_048_576;
    const maximumCommands = options.maximumCommands ?? MAXIMUM_COMMANDS;
    const maximumCommandSubscribers =
      options.maximumCommandSubscribers ?? MAXIMUM_COMMAND_SUBSCRIBERS;
    const maximumSubscribers = options.maximumSubscribers ?? MAXIMUM_SUBSCRIBERS;
    const subscriberIdleMs = options.subscriberIdleMs ?? 60_000;
    const artifactStoreInput = options.artifactStore;
    if (
      typeof dataRoot !== "string" ||
      !dataRoot.startsWith("/") ||
      !Number.isSafeInteger(queueFrames) ||
      queueFrames < 1 ||
      queueFrames > 10_000 ||
      !Number.isSafeInteger(queueBytes) ||
      queueBytes < 1 ||
      queueBytes > 64 * 1_048_576 ||
      !Number.isSafeInteger(maximumCommands) ||
      maximumCommands < 1 ||
      maximumCommands > MAXIMUM_COMMANDS ||
      !Number.isSafeInteger(maximumCommandSubscribers) ||
      maximumCommandSubscribers < 1 ||
      maximumCommandSubscribers > MAXIMUM_COMMAND_SUBSCRIBERS ||
      !Number.isSafeInteger(maximumSubscribers) ||
      maximumSubscribers < 1 ||
      maximumSubscribers > MAXIMUM_SUBSCRIBERS ||
      !Number.isSafeInteger(subscriberIdleMs) ||
      subscriberIdleMs < 1 ||
      subscriberIdleMs > 600_000
    ) {
      throw new TypeError();
    }
    const preadmittedCapability =
      artifactStoreInput === undefined
        ? undefined
        : admitArtifactStoreRecoveryCapability(artifactStoreInput, dataRoot);
    const paths =
      artifactStoreInput === undefined
        ? await DataPathPolicy.create(dataRoot)
        : await DataPathPolicy.openExisting(dataRoot);
    const artifactStore = artifactStoreInput ?? (await ArtifactStore.create({ dataRoot }));
    const artifactCapability = await admitArtifactStoreRecoveryRoot(artifactStore, paths.root);
    if (preadmittedCapability !== undefined && preadmittedCapability !== artifactCapability) {
      throw new TypeError();
    }
    return Object.freeze({
      dataRoot,
      artifactStore,
      artifactCapability,
      queueFrames,
      queueBytes,
      maximumCommands,
      maximumCommandSubscribers,
      maximumSubscribers,
      subscriberIdleMs
    });
  } catch {
    throw createCommandRegistryError("invalid_request");
  }
};
