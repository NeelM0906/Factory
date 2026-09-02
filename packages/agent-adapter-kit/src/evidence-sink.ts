/**
 * Evidence sink port: the interface adapters use to record evidence artifacts.
 *
 * Agent packages never import `ArtifactStore`; composition binds the real store later.
 * The in-memory implementation is for tests and the conformance scaffold.
 */

import { createHash } from "node:crypto";

export interface AgentEvidenceSink {
  record(input: {
    readonly kind: "transcript" | "diff" | "plan" | "permission";
    readonly bytes: Uint8Array;
  }): Promise<{ readonly digest: string }>;
}

interface StoredEvidence {
  readonly kind: "transcript" | "diff" | "plan" | "permission";
  readonly bytes: Uint8Array;
}

/**
 * In-memory evidence sink for tests. Content-addressed by SHA-256.
 */
export class InMemoryEvidenceSink implements AgentEvidenceSink {
  readonly #store = new Map<string, StoredEvidence>();

  async record(input: {
    readonly kind: "transcript" | "diff" | "plan" | "permission";
    readonly bytes: Uint8Array;
  }): Promise<{ readonly digest: string }> {
    const digest = createHash("sha256").update(input.bytes).digest("hex");
    this.#store.set(digest, { kind: input.kind, bytes: input.bytes });
    return { digest };
  }

  get(digest: string): StoredEvidence | undefined {
    return this.#store.get(digest);
  }

  get size(): number {
    return this.#store.size;
  }
}
