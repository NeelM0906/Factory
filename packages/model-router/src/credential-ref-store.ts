import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { CredentialRef } from "@autostack/contracts";

import {
  credentialFilePath,
  type MacosKeychainCredentialRef
} from "./credential/credential-file-layout.js";
import type { SecretProtector } from "./credential/secret-protector.js";

/**
 * Follows `apps/desktop/src/main/credential-store.ts`'s pattern (not its code — see
 * `src/credential/secret-protector.ts`): atomic `open(..., "wx")` write + `rename` into place,
 * `0o600` file / `0o700` directory modes, ownership and symlink checks, fail closed when protection
 * is unavailable. `rename` atomically replaces an existing file, so `put` doubles as a safe upsert:
 * there is never a moment with no file at `path`.
 *
 * Milestone A's local secret store scopes to the Keychain (spec §14.3): only the `macos_keychain`
 * variant of `CredentialRefSchema` is accepted. `vercel`, `server_encrypted`, and `external_vault`
 * refs are refused — silently accepting a store this package does not implement would be the
 * opposite of fail-closed.
 *
 * `resolve` decrypts from disk on every call; the store holds no field that could leak a secret
 * through `JSON.stringify`, `util.inspect`, or `String(store)`.
 */

export interface CredentialRefStoreOptions {
  readonly root: string;
  readonly protector: SecretProtector;
}

export interface CredentialRefStore {
  put(ref: CredentialRef, secret: string): Promise<void>;
  resolve(ref: CredentialRef): Promise<string>;
  delete(ref: CredentialRef): Promise<void>;
}

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const assertSupported = (ref: CredentialRef): MacosKeychainCredentialRef => {
  if (ref.store !== "macos_keychain") {
    throw new Error(`unsupported credential store: ${ref.store}`);
  }
  return ref;
};

const assertAvailable = (protector: SecretProtector): void => {
  if (!protector.isAvailable()) throw new Error("credential protection unavailable");
};

class CredentialRefStoreImpl implements CredentialRefStore {
  readonly #root: string;
  readonly #protector: SecretProtector;

  constructor(options: CredentialRefStoreOptions) {
    assertAvailable(options.protector);
    this.#root = options.root;
    this.#protector = options.protector;
  }

  async put(ref: CredentialRef, secret: string): Promise<void> {
    assertAvailable(this.#protector);
    const supported = assertSupported(ref);
    await this.#prepareRoot();
    const encrypted = this.#protector.encrypt(secret);
    if (encrypted.byteLength === 0) throw new Error("credential protection unavailable");
    const path = credentialFilePath(this.#root, supported);
    const temporaryPath = join(this.#root, `.credential-${randomUUID()}.tmp`);
    const file = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    try {
      await file.writeFile(encrypted);
      await file.sync();
    } finally {
      await file.close();
    }
    await chmod(temporaryPath, PRIVATE_FILE_MODE);
    try {
      await rename(temporaryPath, path);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async resolve(ref: CredentialRef): Promise<string> {
    assertAvailable(this.#protector);
    const supported = assertSupported(ref);
    const path = credentialFilePath(this.#root, supported);
    const encrypted = await this.#readEncrypted(path, ref.id);
    try {
      return this.#protector.decrypt(encrypted);
    } catch {
      throw new Error("credential protection unavailable");
    }
  }

  async delete(ref: CredentialRef): Promise<void> {
    // Deliberately no `assertAvailable` call here, unlike `put`/`resolve`: removing a credential
    // file needs no decryption or encryption, so an unavailable `SecretProtector` is not a reason
    // to fail closed on this operation — a caller must still be able to delete a credential (e.g.
    // during rotation cleanup or an uninstall) even when OS protection has become unavailable.
    const supported = assertSupported(ref);
    const path = credentialFilePath(this.#root, supported);
    try {
      await unlink(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async #readEncrypted(path: string, refId: string): Promise<Buffer> {
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (isMissing(error)) throw new Error(`unknown credential reference: ${refId}`);
      throw error;
    }
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
      metadata.uid !== process.getuid?.()
    ) {
      throw new Error("unsafe credential file");
    }
    const file = await open(path, "r");
    try {
      return await file.readFile();
    } finally {
      await file.close();
    }
  }

  async #prepareRoot(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const metadata = await stat(this.#root);
    if (!metadata.isDirectory() || metadata.uid !== process.getuid?.()) {
      throw new Error("unsafe credential directory");
    }
    await chmod(this.#root, PRIVATE_DIRECTORY_MODE);
  }
}

export const createCredentialRefStore = (options: CredentialRefStoreOptions): CredentialRefStore =>
  new CredentialRefStoreImpl(options);
