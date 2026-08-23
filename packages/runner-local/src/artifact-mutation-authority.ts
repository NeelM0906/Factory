import { AsyncLocalStorage } from "node:async_hooks";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

import type { ArtifactDescriptor } from "@autostack/contracts";

import type { ArtifactStore } from "./artifact-store.js";
import type { WriteArtifactRequest } from "./artifact-types.js";
import {
  assertPrivateDirectory,
  identityOf,
  sameIdentityExceptLinkCount,
  type PathIdentity
} from "./path-security.js";

type ArtifactMutationGuard = () => void;

const mutationAuthority = new AsyncLocalStorage<ArtifactMutationGuard>();
export interface ArtifactStoreRecoveryCapability {
  readonly canonicalRoot: string;
  readonly writeArtifact: ArtifactStore["writeArtifact"];
  readonly findArtifact: ArtifactStore["findArtifact"];
}

interface ArtifactStoreAuthority extends ArtifactStoreRecoveryCapability {
  readonly admittedRoot: string;
  readonly rootIdentity: PathIdentity;
}

const storeAuthorities = new WeakMap<object, ArtifactStoreAuthority>();

const admitArtifactStoreAuthority = (
  store: ArtifactStore,
  expectedRoot: string
): ArtifactStoreAuthority => {
  const authority = storeAuthorities.get(store);
  const admittedRoot = resolve(expectedRoot);
  if (
    authority === undefined ||
    (authority.admittedRoot !== admittedRoot && authority.canonicalRoot !== admittedRoot)
  ) {
    throw new TypeError("Artifact store root mismatch.");
  }
  return authority;
};

export const brandArtifactStoreRoot = async (
  store: ArtifactStore,
  canonicalRoot: string,
  admittedRoot = canonicalRoot
): Promise<void> => {
  if (storeAuthorities.has(store)) throw new TypeError("Artifact store is already branded.");
  const status = await lstat(canonicalRoot);
  assertPrivateDirectory(status);
  const writeArtifact = store.writeArtifact;
  const findArtifact = store.findArtifact;
  storeAuthorities.set(
    store,
    Object.freeze({
      admittedRoot: resolve(admittedRoot),
      canonicalRoot,
      rootIdentity: identityOf(status),
      writeArtifact: (...args: Parameters<ArtifactStore["writeArtifact"]>) =>
        Reflect.apply(writeArtifact, store, args),
      findArtifact: (...args: Parameters<ArtifactStore["findArtifact"]>) =>
        Reflect.apply(findArtifact, store, args)
    })
  );
};

export const admitArtifactStoreRecoveryRoot = async (
  store: ArtifactStore,
  canonicalRoot: string
): Promise<ArtifactStoreRecoveryCapability> => {
  const authority = admitArtifactStoreAuthority(store, canonicalRoot);
  const status = await lstat(canonicalRoot);
  assertPrivateDirectory(status);
  if (!sameIdentityExceptLinkCount(authority.rootIdentity, identityOf(status))) {
    throw new TypeError("Artifact store root identity mismatch.");
  }
  return authority;
};

/** Filesystem-free exact capability admission for ordering ahead of path initialization. */
export const admitArtifactStoreRecoveryCapability = (
  store: ArtifactStore,
  expectedRoot: string
): ArtifactStoreRecoveryCapability => admitArtifactStoreAuthority(store, expectedRoot);

export const snapshotArtifactStoreCapability = (store: unknown): ArtifactStore => {
  if ((typeof store !== "object" && typeof store !== "function") || store === null) {
    throw new TypeError("Artifact store capability is unavailable.");
  }
  const authority = storeAuthorities.get(store as ArtifactStore);
  if (authority === undefined) throw new TypeError("Artifact store capability is unavailable.");
  const facade = Object.freeze({
    writeArtifact: authority.writeArtifact,
    findArtifact: authority.findArtifact
  }) as ArtifactStore;
  storeAuthorities.set(facade, authority);
  return facade;
};

export const assertArtifactMutationAuthorized = (): void => {
  mutationAuthority.getStore()?.();
};

export const artifactMutationIsGuarded = (): boolean => mutationAuthority.getStore() !== undefined;

export const writeArtifactUnderRecoveryGuard = async (
  store: ArtifactStore,
  request: WriteArtifactRequest,
  guard: ArtifactMutationGuard
): Promise<ArtifactDescriptor> => {
  const authority = storeAuthorities.get(store);
  if (authority === undefined) throw new TypeError("Artifact store capability is unavailable.");
  return await writeArtifactCapabilityUnderRecoveryGuard(authority, request, guard);
};

export const writeArtifactCapabilityUnderRecoveryGuard = async (
  authority: ArtifactStoreRecoveryCapability,
  request: WriteArtifactRequest,
  guard: ArtifactMutationGuard
): Promise<ArtifactDescriptor> => {
  return await mutationAuthority.run(guard, async () => await authority.writeArtifact(request));
};
