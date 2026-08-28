import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CredentialRefSchema,
  type CredentialRef,
  type CredentialRefId
} from "@autostack/contracts";

import { createCredentialRefStore, type CredentialRefStore } from "../src/credential-ref-store.js";
import type { SecretProtector } from "../src/credential/secret-protector.js";
import {
  createCredentialResolver,
  type CredentialRefRegistry
} from "../src/credential/credential-resolver.js";

const XOR_KEY = 0x5a;

const createFakeProtector = (): SecretProtector => {
  const xor = (input: Buffer): Buffer => {
    const out = Buffer.alloc(input.byteLength);
    for (let index = 0; index < input.byteLength; index += 1) {
      out[index] = (input[index] ?? 0) ^ XOR_KEY;
    }
    return out;
  };
  return {
    isAvailable: () => true,
    encrypt: (value: string) => xor(Buffer.from(value, "utf8")),
    decrypt: (value: Buffer) => xor(value).toString("utf8")
  };
};

let refCounter = 0;
const makeMacosRef = (): CredentialRef => {
  refCounter += 1;
  return CredentialRefSchema.parse({
    schemaVersion: 1,
    id: `cred_${randomUUID()}`,
    workspaceId: `ws_${randomUUID()}`,
    provider: "openai",
    store: "macos_keychain",
    locator: { service: `service-${refCounter}`, account: `account-${refCounter}` },
    metadata: { label: `Credential ${refCounter}` },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
};

const createRegistry = (refs: readonly CredentialRef[]): CredentialRefRegistry => {
  const byId = new Map(refs.map((ref) => [ref.id, ref] as const));
  return { get: (id) => byId.get(id) };
};

describe("createCredentialResolver (unit, fake store)", () => {
  it("looks the id up in the registry and delegates to the store with the full ref", async () => {
    const ref = makeMacosRef();
    const registry = createRegistry([ref]);
    const resolve = vi.fn(async (resolvedRef: CredentialRef) => {
      expect(resolvedRef).toEqual(ref);
      return "the-secret-value";
    });
    const fakeStore = {
      put: vi.fn(),
      resolve,
      delete: vi.fn()
    } as unknown as CredentialRefStore;

    const resolver = createCredentialResolver({ registry, store: fakeStore });
    const secret = await resolver.resolve(ref.id);

    expect(secret).toBe("the-secret-value");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(ref);
  });

  it("fails closed on an unknown id without ever calling the store — never falls through to an unauthenticated request", async () => {
    const knownRef = makeMacosRef();
    const registry = createRegistry([knownRef]);
    const resolve = vi.fn();
    const fakeStore = {
      put: vi.fn(),
      resolve,
      delete: vi.fn()
    } as unknown as CredentialRefStore;

    const resolver = createCredentialResolver({ registry, store: fakeStore });
    const unknownId = "cred_00000000-0000-4000-8000-000000000000" as CredentialRefId;

    await expect(resolver.resolve(unknownId)).rejects.toThrow(/unknown credential reference/);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("createCredentialResolver (integration, real store)", () => {
  let root: string;
  let store: CredentialRefStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "model-router-credential-resolver-"));
    store = createCredentialRefStore({ root, protector: createFakeProtector() });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves the exact stored secret through the registry -> store join", async () => {
    const ref = makeMacosRef();
    await store.put(ref, "super-secret-value");
    const registry = createRegistry([ref]);
    const resolver = createCredentialResolver({ registry, store });

    await expect(resolver.resolve(ref.id)).resolves.toBe("super-secret-value");
  });

  it("fails with the store's own unknown-reference error when a registered ref was never put", async () => {
    const ref = makeMacosRef();
    const registry = createRegistry([ref]);
    const resolver = createCredentialResolver({ registry, store });

    await expect(resolver.resolve(ref.id)).rejects.toThrow(/unknown credential reference/);
  });
});
