import { describe, expect, it } from "vitest";

import { InMemoryEvidenceSink, type AgentEvidenceSink } from "../src/evidence-sink.js";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("InMemoryEvidenceSink", () => {
  it("returns a lowercase 64-hex SHA-256 digest", async () => {
    const sink: AgentEvidenceSink = new InMemoryEvidenceSink();
    const result = await sink.record({ kind: "transcript", bytes: encode("hello") });

    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is content-addressed: identical bytes produce the identical digest", async () => {
    const sink: AgentEvidenceSink = new InMemoryEvidenceSink();
    const a = await sink.record({ kind: "transcript", bytes: encode("same content") });
    const b = await sink.record({ kind: "transcript", bytes: encode("same content") });

    expect(a.digest).toBe(b.digest);
  });

  it("different bytes produce different digests", async () => {
    const sink: AgentEvidenceSink = new InMemoryEvidenceSink();
    const a = await sink.record({ kind: "transcript", bytes: encode("content A") });
    const b = await sink.record({ kind: "transcript", bytes: encode("content B") });

    expect(a.digest).not.toBe(b.digest);
  });

  it("stores the recorded evidence for later retrieval", async () => {
    const sink = new InMemoryEvidenceSink();
    const result = await sink.record({ kind: "diff", bytes: encode("diff content") });

    const stored = sink.get(result.digest);
    expect(stored).toBeDefined();
    expect(stored!.kind).toBe("diff");
    expect(new TextDecoder().decode(stored!.bytes)).toBe("diff content");
  });
});

describe("evidence sink failure handling", () => {
  it("a sink failure becomes a classified adapter failure, not an unhandled rejection", async () => {
    const failingSink: AgentEvidenceSink = {
      async record(): Promise<{ digest: string }> {
        throw new Error("Storage unavailable");
      }
    };

    await expect(
      failingSink.record({ kind: "transcript", bytes: encode("data") })
    ).rejects.toThrow("Storage unavailable");
  });
});
