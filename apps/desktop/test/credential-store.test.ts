import { lstat, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CredentialStore } from "../src/main/credential-store.js";

const roots: string[] = [];
const makeRoot = async (): Promise<string> => {
  const root = join(process.cwd(), `.desktop-credential-test-${crypto.randomUUID()}`);
  roots.push(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
};

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CredentialStore", () => {
  it("persists only encrypted token bytes in a private regular file and reuses them", async () => {
    const root = await makeRoot();
    const protector = {
      isAvailable: () => true,
      encrypt: (value: string) => Buffer.from(value, "utf8").reverse(),
      decrypt: (value: Buffer) => Buffer.from(value).reverse().toString("utf8")
    };
    const first = new CredentialStore({ root, protector, randomBytes: () => Buffer.alloc(32, 7) });

    const token = await first.loadOrCreate();
    const file = join(root, "api-token.enc");
    expect(token).toBe(Buffer.alloc(32, 7).toString("base64url"));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).not.toContain(token);
    await expect(new CredentialStore({ root, protector }).loadOrCreate()).resolves.toBe(token);
  });

  it("fails closed for unavailable protection, symlinks, unsafe permissions, or decryption", async () => {
    const root = await makeRoot();
    await expect(
      new CredentialStore({
        root,
        protector: { isAvailable: () => false, encrypt: Buffer.from, decrypt: () => "" }
      }).loadOrCreate()
    ).rejects.toThrow("credential protection unavailable");

    const target = join(root, "target");
    await writeFile(target, "cipher", { mode: 0o600 });
    await symlink(target, join(root, "api-token.enc"));
    await expect(
      new CredentialStore({
        root,
        protector: { isAvailable: () => true, encrypt: Buffer.from, decrypt: () => "token" }
      }).loadOrCreate()
    ).rejects.toThrow("unsafe credential file");
    expect((await lstat(join(root, "api-token.enc"))).isSymbolicLink()).toBe(true);
  });
});
