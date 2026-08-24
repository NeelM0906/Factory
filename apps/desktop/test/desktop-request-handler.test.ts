import { describe, expect, it, vi } from "vitest";

import { createDesktopRequestHandler } from "../src/main/desktop-request-handler.js";

describe("desktop IPC request handler", () => {
  it("authorizes the sender before injecting the main-owned bearer", async () => {
    const authorized: unknown[] = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer main-only-token");
      return Response.json({ items: [] });
    });
    const handler = createDesktopRequestHandler({
      authorize: (event: { readonly sender: string }) => authorized.push(event),
      getOrigin: () => "http://127.0.0.1:4567",
      getToken: () => "main-only-token",
      fetch
    });
    const event = { sender: "trusted-renderer" };

    await expect(handler(event, { operation: "factory.runs.list" })).resolves.toEqual({
      items: []
    });
    expect(authorized).toEqual([event]);
    expect(JSON.stringify({ operation: "factory.runs.list" })).not.toContain("main-only-token");
  });

  it("does not contact the control plane for an unauthorized sender", async () => {
    const fetch = vi.fn();
    const handler = createDesktopRequestHandler({
      authorize: () => {
        throw new TypeError("untrusted desktop IPC sender");
      },
      getOrigin: () => "http://127.0.0.1:4567",
      getToken: () => "main-only-token",
      fetch
    });

    await expect(handler({}, { operation: "factory.runs.list" })).rejects.toThrow(
      "untrusted desktop IPC sender"
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
