import { describe, expect, it } from "vitest";

import { DurableTerminalEvidenceAuthority } from "../src/utility/terminal-evidence-authority.js";

const uuid = "123e4567-e89b-42d3-a456-426614174000";
const request = {
  workspaceId: `ws_${uuid}`,
  runId: `run_${uuid}`,
  environmentId: `env_${uuid}`,
  environmentAuthorizationId: `envauth_${uuid}`,
  environmentAuthorizationDigest: "a".repeat(64),
  terminalRunEvidence: {
    status: "completed",
    terminalEventSequence: 7,
    terminalEventDigest: "b".repeat(64)
  },
  idempotency: { key: "dispose-1" }
} as const;

const verification = {
  workspaceId: request.workspaceId,
  runId: request.runId,
  environmentId: request.environmentId,
  environmentAuthorizationId: request.environmentAuthorizationId,
  environmentAuthorizationDigest: request.environmentAuthorizationDigest,
  terminalRunEvidence: request.terminalRunEvidence
};

describe("production terminal evidence authority", () => {
  it("rejects caller evidence unless the durable control-plane channel authorized it", () => {
    const authority = new DurableTerminalEvidenceAuthority();
    expect(authority.verify(verification as never)).toBe(false);
  });

  it("accepts an exact durable binding once and rejects forged ownership or evidence", () => {
    const authority = new DurableTerminalEvidenceAuthority();
    authority.authorize(request);
    expect(
      authority.verify({
        ...verification,
        runId: `run_223e4567-e89b-42d3-a456-426614174000`
      } as never)
    ).toBe(false);
    expect(authority.verify(verification as never)).toBe(false);

    authority.authorize(request);
    expect(
      authority.verify({
        ...verification,
        terminalRunEvidence: {
          ...verification.terminalRunEvidence,
          terminalEventDigest: "c".repeat(64)
        }
      } as never)
    ).toBe(false);

    authority.authorize(request);
    expect(authority.verify(verification as never)).toBe(true);
    expect(authority.verify(verification as never)).toBe(false);
  });

  it("rejects an expired durable authorization", () => {
    let now = 0;
    const authority = new DurableTerminalEvidenceAuthority({
      now: () => now,
      ttlMs: 10
    });
    authority.authorize(request);
    now = 10;
    expect(authority.verify(verification as never)).toBe(false);
  });
});
