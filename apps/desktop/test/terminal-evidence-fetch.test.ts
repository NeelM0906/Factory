import { describe, expect, it, vi } from "vitest";

import { createTerminalEvidenceAuthorizingFetch } from "../src/utility/terminal-evidence-fetch.js";

describe("control-plane terminal evidence fetch", () => {
  it("authorizes the exact durable disposal record before sending it to the host", async () => {
    const order: string[] = [];
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
    const fetch = createTerminalEvidenceAuthorizingFetch({
      hostOrigin: "http://127.0.0.1:4401",
      authorize: async (value) => {
        expect(value).toEqual(request);
        order.push("authorized");
      },
      fetch: vi.fn(async () => {
        order.push("sent");
        return Response.json({ disposed: true });
      })
    });

    await fetch("http://127.0.0.1:4401/v1/environments/env", {
      method: "DELETE",
      body: JSON.stringify(request)
    });
    expect(order).toEqual(["authorized", "sent"]);
  });
});
