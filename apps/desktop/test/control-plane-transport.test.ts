import { describe, expect, it, vi } from "vitest";

import { createDesktopControlPlaneTransport } from "../src/main/control-plane-transport.js";

describe("desktop control-plane transport", () => {
  it("routes a named operation to the fixed verified origin and injects the main-owned bearer", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input).toBe("http://127.0.0.1:4567/v1/runs?cursor=42");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-token");
      return Response.json({ items: [] });
    });
    const transport = createDesktopControlPlaneTransport({
      origin: "http://127.0.0.1:4567",
      getToken: () => "private-token",
      fetch
    });

    await expect(
      transport.request({ operation: "factory.runs.list", cursor: 42 })
    ).resolves.toEqual({ items: [] });
    expect(JSON.stringify({ operation: "factory.runs.list", cursor: 42 })).not.toContain(
      "private-token"
    );
  });

  it("rejects non-loopback origins and writable local operations without a dispatcher", async () => {
    expect(() =>
      createDesktopControlPlaneTransport({
        origin: "https://example.com",
        getToken: () => "token",
        fetch: vi.fn()
      })
    ).toThrow("numeric loopback");
    const transport = createDesktopControlPlaneTransport({
      origin: "http://127.0.0.1:4567",
      getToken: () => "token",
      fetch: vi.fn()
    });
    await expect(
      transport.request({
        operation: "local.inspect",
        repositoryCapabilityId: "repocap_123e4567-e89b-42d3-a456-426614174000",
        baseRef: "main",
        branchSlug: "safe-feature"
      } as never)
    ).rejects.toThrow("dispatcher unavailable");
  });

  it("routes only caller-safe local inspect, prepare, and start requests through the typed dispatcher", async () => {
    const requests: unknown[] = [];
    const transport = createDesktopControlPlaneTransport({
      origin: "http://127.0.0.1:4567",
      getToken: () => "main-only-token",
      fetch: vi.fn(),
      localDispatcher: {
        request: async (request) => {
          requests.push(request);
          throw new Error("stub dispatcher reached");
        }
      }
    });
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    const candidates = [
      {
        operation: "local.inspect",
        repositoryCapabilityId: `repocap_${uuid}`,
        baseRef: "main",
        branchSlug: "safe-feature"
      },
      {
        operation: "local.prepare",
        runId: `run_${uuid}`,
        environmentId: `env_${uuid}`,
        environmentAuthorizationId: `envauth_${uuid}`,
        inspectedSourceCapabilityId: `inspsrc_${uuid}`,
        idempotencyKey: "prepare-1"
      },
      {
        operation: "local.start",
        runId: `run_${uuid}`,
        environmentId: `env_${uuid}`,
        commandId: `cmd_${uuid}`,
        commandAuthorizationId: `cmdauth_${uuid}`,
        command: {
          executable: "pnpm",
          args: ["test"],
          cwd: ".",
          environment: [],
          timeoutSeconds: 60,
          terminal: { columns: 80, rows: 24 }
        },
        idempotencyKey: "start-1"
      }
    ] as const;

    for (const candidate of candidates) {
      await expect(transport.request(candidate as never)).rejects.toThrow(
        "stub dispatcher reached"
      );
    }
    expect(requests.map((request) => (request as { operation: string }).operation)).toEqual([
      "local.inspect",
      "local.prepare",
      "local.start"
    ]);
    expect(JSON.stringify(requests)).not.toMatch(/sourcePath|approvalId/);
  });
});
