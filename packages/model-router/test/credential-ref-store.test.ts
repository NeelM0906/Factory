import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CredentialRefSchema, type CredentialRef } from "@autostack/contracts";

import { createCredentialRefStore } from "../src/credential-ref-store.js";
import type { SecretProtector } from "../src/credential/secret-protector.js";

const XOR_KEY = 0x5a;

interface FakeProtector extends SecretProtector {
  setAvailable(value: boolean): void;
  setEncryptOverride(fn: ((value: string) => Buffer) | undefined): void;
  setDecryptOverride(fn: ((value: Buffer) => string) | undefined): void;
}

const createFakeProtector = (): FakeProtector => {
  let available = true;
  let encryptOverride: ((value: string) => Buffer) | undefined;
  let decryptOverride: ((value: Buffer) => string) | undefined;

  const xorEncrypt = (value: string): Buffer => {
    const bytes = Buffer.from(value, "utf8");
    const out = Buffer.alloc(bytes.byteLength);
    for (let index = 0; index < bytes.byteLength; index += 1) {
      out[index] = (bytes[index] ?? 0) ^ XOR_KEY;
    }
    return out;
  };

  const xorDecrypt = (value: Buffer): string => {
    const out = Buffer.alloc(value.byteLength);
    for (let index = 0; index < value.byteLength; index += 1) {
      out[index] = (value[index] ?? 0) ^ XOR_KEY;
    }
    return out.toString("utf8");
  };

  return {
    isAvailable: () => available,
    encrypt: (value: string) => (encryptOverride ? encryptOverride(value) : xorEncrypt(value)),
    decrypt: (value: Buffer) => (decryptOverride ? decryptOverride(value) : xorDecrypt(value)),
    setAvailable: (value: boolean) => {
      available = value;
    },
    setEncryptOverride: (fn) => {
      encryptOverride = fn;
    },
    setDecryptOverride: (fn) => {
      decryptOverride = fn;
    }
  };
};

let refCounter = 0;

const makeMacosRef = (locator?: { service?: string; account?: string }): CredentialRef => {
  refCounter += 1;
  return CredentialRefSchema.parse({
    schemaVersion: 1,
    id: `cred_${randomUUID()}`,
    workspaceId: `ws_${randomUUID()}`,
    provider: "openai",
    store: "macos_keychain",
    locator: {
      service: locator?.service ?? `service-${refCounter}`,
      account: locator?.account ?? `account-${refCounter}`
    },
    metadata: { label: `Credential ${refCounter}` },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
};

const makeUnsupportedRef = (
  store: "vercel" | "server_encrypted" | "external_vault"
): CredentialRef => {
  refCounter += 1;
  const base = {
    schemaVersion: 1,
    id: `cred_${randomUUID()}`,
    workspaceId: `ws_${randomUUID()}`,
    provider: "openai",
    metadata: { label: `Credential ${refCounter}` },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (store === "vercel") {
    return CredentialRefSchema.parse({
      ...base,
      store,
      locator: { projectId: `proj-${refCounter}`, name: `name-${refCounter}` }
    });
  }
  if (store === "server_encrypted") {
    return CredentialRefSchema.parse({
      ...base,
      store,
      locator: { recordId: `record-${refCounter}` }
    });
  }
  return CredentialRefSchema.parse({
    ...base,
    store,
    locator: { vault: `vault-${refCounter}`, path: `path-${refCounter}`, key: `key-${refCounter}` }
  });
};

describe("credential ref store", () => {
  let root: string;
  let protector: FakeProtector;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "credential-ref-store-"));
    protector = createFakeProtector();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("round trip", () => {
    it("returns the exact secret put earlier", async () => {
      const store = createCredentialRefStore({ root, protector });
      const ref = makeMacosRef();

      await store.put(ref, "sk-super-secret-value");

      await expect(store.resolve(ref)).resolves.toBe("sk-super-secret-value");
    });

    it("throws naming the id and nothing else for an unknown reference", async () => {
      const store = createCredentialRefStore({ root, protector });
      const ref = makeMacosRef();

      await expect(store.resolve(ref)).rejects.toThrow(ref.id);
    });

    it.each(["vercel", "server_encrypted", "external_vault"] as const)(
      "refuses the %s store as unsupported",
      async (unsupportedStore) => {
        const store = createCredentialRefStore({ root, protector });
        const ref = makeUnsupportedRef(unsupportedStore);

        await expect(store.put(ref, "secret")).rejects.toThrow(/unsupported credential store/i);
      }
    );

    it("derives a safe on-disk filename from a hostile locator", async () => {
      const store = createCredentialRefStore({ root, protector });
      const hostileRef = makeMacosRef({
        service: "../../etc/passwd\0",
        account: "a/b/../../c"
      });

      await store.put(hostileRef, "hostile-secret");

      await expect(store.resolve(hostileRef)).resolves.toBe("hostile-secret");

      const entries = await import("node:fs/promises").then((fs) => fs.readdir(root));
      for (const entry of entries) {
        expect(entry).not.toContain("..");
        expect(entry).not.toContain("/");
        expect(entry).not.toContain(" ");
      }
      const rootStat = await stat(root);
      expect(rootStat.isDirectory()).toBe(true);
    });

    it("never collides two distinct locators onto the same file", async () => {
      const store = createCredentialRefStore({ root, protector });
      const refA = makeMacosRef({ service: "svc", account: "one" });
      const refB = makeMacosRef({ service: "svc", account: "two" });

      await store.put(refA, "secret-a");
      await store.put(refB, "secret-b");

      await expect(store.resolve(refA)).resolves.toBe("secret-a");
      await expect(store.resolve(refB)).resolves.toBe("secret-b");
    });
  });

  describe("fail closed", () => {
    it("refuses construction when the protector is unavailable", () => {
      protector.setAvailable(false);

      expect(() => createCredentialRefStore({ root, protector })).toThrow();
    });

    it("refuses put when the protector becomes unavailable after construction", async () => {
      const store = createCredentialRefStore({ root, protector });
      protector.setAvailable(false);
      const ref = makeMacosRef();

      await expect(store.put(ref, "secret")).rejects.toThrow();

      const entries = await import("node:fs/promises").then((fs) => fs.readdir(root));
      expect(entries).toHaveLength(0);
    });

    it("refuses resolve when the protector becomes unavailable after construction", async () => {
      const store = createCredentialRefStore({ root, protector });
      const ref = makeMacosRef();
      await store.put(ref, "secret");
      protector.setAvailable(false);

      await expect(store.resolve(ref)).rejects.toThrow();
    });

    it("treats an empty-buffer encrypt result as protection unavailable, not a missing credential", async () => {
      const store = createCredentialRefStore({ root, protector });
      protector.setEncryptOverride(() => Buffer.alloc(0));
      const ref = makeMacosRef();

      await expect(store.put(ref, "secret")).rejects.toThrow(/protection unavailable/i);

      const entries = await import("node:fs/promises").then((fs) => fs.readdir(root));
      expect(entries).toHaveLength(0);
    });

    it("treats a decrypt throw as protection unavailable, not a missing credential", async () => {
      const store = createCredentialRefStore({ root, protector });
      const ref = makeMacosRef();
      await store.put(ref, "secret");
      protector.setDecryptOverride(() => {
        throw new Error("boom");
      });

      await expect(store.resolve(ref)).rejects.toThrow(/protection unavailable/i);
    });
  });

  describe("no plaintext at rest and no leak", () => {
    const findStoredFile = async (): Promise<string> => {
      const entries = await (await import("node:fs/promises")).readdir(root);
      const [entry] = entries;
      if (entry === undefined) throw new Error("expected exactly one stored credential file");
      return join(root, entry);
    };

    it("never writes the plaintext secret to disk, at any offset", async () => {
      const store = createCredentialRefStore({ root, protector });
      const ref = makeMacosRef();
      const secret = "sk-do-not-leak-this-value-anywhere";

      await store.put(ref, secret);

      const filePath = await findStoredFile();
      const raw = await readFile(filePath);
      const rawText = raw.toString("latin1");
      for (let offset = 0; offset <= rawText.length - secret.length; offset += 1) {
        expect(rawText.slice(offset, offset + secret.length)).not.toBe(secret);
      }
    });

    it("writes the directory at 0o700 and the credential file at 0o600", async () => {
      const store = createCredentialRefStore({ root, protector });
      const ref = makeMacosRef();

      await store.put(ref, "secret");

      const rootStat = await stat(root);
      expect(rootStat.mode & 0o777).toBe(0o700);
      const filePath = await findStoredFile();
      const fileStat = await stat(filePath);
      expect(fileStat.mode & 0o777).toBe(0o600);
    });

    it("refuses a pre-existing credential file with wider modes rather than reading it", async () => {
      const store = createCredentialRefStore({ root, protector });
      const ref = makeMacosRef();
      await store.put(ref, "secret");
      const filePath = await findStoredFile();
      await chmod(filePath, 0o644);

      await expect(store.resolve(ref)).rejects.toThrow();
    });

    it("leaks no fragment of the secret through serialization or error text", async () => {
      const store = createCredentialRefStore({ root, protector });
      const ref = makeMacosRef();
      const secret = "sk-serialization-leak-check-value";
      await store.put(ref, secret);

      expect(JSON.stringify(store)).not.toContain(secret);
      expect(inspect(store, { depth: null })).not.toContain(secret);
      expect(String(store)).not.toContain(secret);

      const unknownRef = makeMacosRef();
      try {
        await store.resolve(unknownRef);
        throw new Error("expected resolve to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const err = error as Error;
        expect(err.message).not.toContain(secret);
        expect(err.stack ?? "").not.toContain(secret);
      }

      protector.setDecryptOverride(() => {
        throw new Error("boom");
      });
      try {
        await store.resolve(ref);
        throw new Error("expected resolve to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const err = error as Error;
        expect(err.message).not.toContain(secret);
        expect(err.stack ?? "").not.toContain(secret);
      }
    });

    it("exposes no cached plaintext: resolve re-reads and re-decrypts from disk every call", async () => {
      const store = createCredentialRefStore({ root, protector });
      const ref = makeMacosRef();
      await store.put(ref, "first-secret");
      await expect(store.resolve(ref)).resolves.toBe("first-secret");

      const filePath = await findStoredFile();
      await writeFile(filePath, protector.encrypt("second-secret"));
      await chmod(filePath, 0o600);

      await expect(store.resolve(ref)).resolves.toBe("second-secret");
    });

    it("removes the credential file on delete, and a subsequent resolve throws the unknown-id error", async () => {
      const store = createCredentialRefStore({ root, protector });
      const ref = makeMacosRef();
      await store.put(ref, "secret");

      await store.delete(ref);

      await expect(store.resolve(ref)).rejects.toThrow(ref.id);
    });
  });
});
