import { basename } from "node:path";

import {
  RepositoryCapabilityIdSchema,
  type RepositoryCapability,
  type RepositoryCapabilityId
} from "@autostack/contracts";

interface StoredCapability {
  readonly path: string;
  readonly expiresAtMs: number;
}

export interface RepositoryCapabilityRegistryOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
}

export class RepositoryCapabilityRegistry {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #capabilities = new Map<RepositoryCapabilityId, StoredCapability>();

  constructor(options: RepositoryCapabilityRegistryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0) throw new TypeError("invalid ttl");
  }

  async register(
    selectedPath: string,
    canonicalize: (path: string) => Promise<string>
  ): Promise<RepositoryCapability> {
    const canonicalPath = await canonicalize(selectedPath);
    const label = basename(canonicalPath);
    if (label.length === 0 || label === "." || label === "..") throw new TypeError("invalid path");
    const id = RepositoryCapabilityIdSchema.parse(`repocap_${crypto.randomUUID()}`);
    const expiresAtMs = this.#now() + this.#ttlMs;
    this.#capabilities.set(id, { path: canonicalPath, expiresAtMs });
    return { id, label, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  resolve(id: RepositoryCapabilityId): string {
    const capability = this.#capabilities.get(id);
    if (capability === undefined) throw new TypeError("unknown repository capability");
    if (capability.expiresAtMs <= this.#now()) {
      this.#capabilities.delete(id);
      throw new TypeError("expired repository capability");
    }
    return capability.path;
  }

  clear(): void {
    this.#capabilities.clear();
  }
}
