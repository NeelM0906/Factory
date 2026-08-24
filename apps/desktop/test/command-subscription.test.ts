import { describe, expect, it, vi } from "vitest";

import { followDesktopCommand } from "../src/main/command-subscription.js";

describe("desktop command subscription", () => {
  it("injects the main bearer and resumes a lagged cursor without duplicating events", async () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    const frames = [
      [{ type: "subscription.lagged", lastDurableSequence: 2, resumeCursor: 2 }],
      [
        {
          type: "runner.event",
          event: {
            type: "terminal.output",
            workspaceId: `ws_${uuid}`,
            runId: `run_${uuid}`,
            commandId: `cmd_${uuid}`,
            sequence: 3,
            occurredAt: "2026-08-23T12:00:00.000Z",
            stream: "pty",
            text: "done"
          }
        },
        {
          type: "runner.event",
          event: {
            type: "stream.error",
            workspaceId: `ws_${uuid}`,
            runId: `run_${uuid}`,
            commandId: `cmd_${uuid}`,
            sequence: 4,
            occurredAt: "2026-08-23T12:00:01.000Z",
            code: "guardian_lost",
            message: "host generation retired"
          }
        }
      ]
    ];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer main-only-token");
      const body =
        frames
          .shift()!
          .map((item) => JSON.stringify(item))
          .join("\n") + "\n";
      return new Response(body, { status: 200 });
    });
    const received: unknown[] = [];

    await followDesktopCommand({
      origin: "http://127.0.0.1:4567",
      getToken: () => "main-only-token",
      request: {
        operation: "local.events",
        environmentId: `env_${uuid}`,
        commandId: `cmd_${uuid}`,
        after: 0
      } as never,
      signal: new AbortController().signal,
      emit: (item) => received.push(item),
      fetch
    });

    expect(
      fetch.mock.calls.map(([input]) => String(input).slice(String(input).lastIndexOf("?")))
    ).toEqual(["?after=0", "?after=2"]);
    expect(
      received
        .filter((item) => (item as { type: string }).type === "runner.event")
        .map((item) => (item as { event: { sequence: number } }).event.sequence)
    ).toEqual([3, 4]);
  });
});
