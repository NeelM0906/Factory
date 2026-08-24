import { randomBytes as nodeRandomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, open, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface SecretProtector {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export interface CredentialStoreOptions {
  readonly root: string;
  readonly protector: SecretProtector;
  readonly randomBytes?: (size: number) => Buffer;
}

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

export class CredentialStore {
  readonly #root: string;
  readonly #path: string;
  readonly #protector: SecretProtector;
  readonly #randomBytes: (size: number) => Buffer;

  constructor(options: CredentialStoreOptions) {
    this.#root = options.root;
    this.#path = join(options.root, "api-token.enc");
    this.#protector = options.protector;
    this.#randomBytes = options.randomBytes ?? nodeRandomBytes;
  }

  async loadOrCreate(): Promise<string> {
    if (!this.#protector.isAvailable()) throw new Error("credential protection unavailable");
    await this.#prepareRoot();
    const existing = await this.#readExisting();
    if (existing !== undefined) return existing;

    const tokenBytes = this.#randomBytes(32);
    if (tokenBytes.byteLength < 32) throw new Error("credential generation failed");
    const token = tokenBytes.toString("base64url");
    const encrypted = this.#protector.encrypt(token);
    if (encrypted.byteLength === 0) throw new Error("credential encryption failed");
    const temporaryPath = join(this.#root, `.api-token-${crypto.randomUUID()}.tmp`);
    const file = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    try {
      await file.writeFile(encrypted);
      await file.sync();
    } finally {
      await file.close();
    }
    await chmod(temporaryPath, PRIVATE_FILE_MODE);
    try {
      await link(temporaryPath, this.#path);
      return token;
    } catch (error) {
      const raced = await this.#readExisting();
      if (raced !== undefined) return raced;
      throw error;
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
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

  async #readExisting(): Promise<string | undefined> {
    try {
      const metadata = await lstat(this.#path);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
        metadata.uid !== process.getuid?.()
      ) {
        throw new Error("unsafe credential file");
      }
      const file = await open(this.#path, "r");
      try {
        const encrypted = await file.readFile();
        const token = this.#protector.decrypt(encrypted);
        if (token.length < 43 || token.length > 512)
          throw new Error("credential decryption failed");
        return token;
      } catch (error) {
        if (error instanceof Error && error.message === "unsafe credential file") throw error;
        throw new Error("credential decryption failed");
      } finally {
        await file.close();
      }
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }
}
