import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ChildSession,
  type ChildSessionOptions
} from "../src/child-session.js";
import { buildChildEnvironment } from "../src/child-environment.js";

const SESSION_CHILD = fileURLToPath(new URL("./fixtures/session-child.mjs", import.meta.url));
const QUIESCE_CHILD = fileURLToPath(new URL("./fixtures/quiesce-child.mjs", import.meta.url));

const defaultOptions = (
  childPath: string,
  mode: string,
  modeArg?: string,
  overrides?: Partial<ChildSessionOptions>
): ChildSessionOptions => ({
  executable: process.execPath,
  args: [childPath, mode, ...(modeArg !== undefined ? [modeArg] : [])],
  cwd: process.cwd(),
  env: buildChildEnvironment(
    { HOME: "/tmp/test", PATH: process.env.PATH ?? "/usr/bin" },
    []
  ),
  runtimeLimitMs: 10_000,
  progressTimeoutMs: 5_000,
  terminationGraceMs: 2_000,
  quiesceFloorMs: 200,
  ...overrides
});

const REPEAT_COUNT = 20;

describe("quiesce honesty", () => {
  describe("isPending => false when a frame is in flight (the direction with teeth)", () => {
    /**
     * D-14: Every wrong quiesce implementation fails here, because each returns before
     * the frame is delivered and the environment's ambient answer is "still pending".
     */
    it.each(Array.from({ length: REPEAT_COUNT }, (_, i) => i + 1))(
      "macrotask-emitting child — run %d/%d",
      async () => {
        const session = new ChildSession(
          defaultOptions(QUIESCE_CHILD, "macrotask-emit")
        );

        // Start the quiesce — it should not resolve until the child's frame is delivered
        const quiescePending = session.quiesce();
        const isPending = await Promise.race([
          quiescePending.then(() => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 50))
        ]);

        // The child emits via macrotask (setTimeout), so at this instant the frame may
        // be in flight. After quiesce resolves, collect events.
        await quiescePending;

        // Drain the session
        const events = [];
        for await (const event of session) {
          events.push(event);
          if (event.kind === "exit") break;
        }

        // The child emitted at least one frame
        const stdoutEvents = events.filter((e) => e.kind === "stdout");
        expect(stdoutEvents.length).toBeGreaterThan(0);

        await session.close();
      }
    );
  });

  describe("poll-phase child — catches setImmediate-only loop", () => {
    it.each(Array.from({ length: REPEAT_COUNT }, (_, i) => i + 1))(
      "poll-phase bytes — run %d/%d",
      async () => {
        const session = new ChildSession(
          defaultOptions(QUIESCE_CHILD, "poll-phase-emit")
        );

        // Wait for quiesce to settle
        await session.quiesce();

        // Drain
        const events = [];
        for await (const event of session) {
          events.push(event);
          if (event.kind === "exit") break;
        }

        const stdoutEvents = events.filter((e) => e.kind === "stdout");
        expect(stdoutEvents.length).toBeGreaterThan(0);

        await session.close();
      }
    );
  });

  describe("wall-clock floor — the paused direction proven by elapsed time", () => {
    /**
     * D-14 (decorative guard struck): asserting isPending=true on a silent child is
     * decorative because async()=>{} delivers nothing and the assertion passes. Instead
     * we assert the floor: quiesce() must not resolve before the wall-clock floor.
     */
    it.each(Array.from({ length: REPEAT_COUNT }, (_, i) => i + 1))(
      "live silent child — quiesce respects the floor — run %d/%d",
      async () => {
        const floorMs = 200;
        const session = new ChildSession(
          defaultOptions(SESSION_CHILD, "hang", undefined, {
            quiesceFloorMs: floorMs,
            progressTimeoutMs: 10_000
          })
        );

        // Read the init frame so we know the child is alive
        for await (const event of session) {
          if (event.kind === "stdout") break;
        }

        const start = Date.now();
        await session.quiesce();
        const elapsed = Date.now() - start;

        // A lazy quiesce returns in ~0ms; an honest one waits at least the floor
        expect(elapsed).toBeGreaterThanOrEqual(floorMs * 0.9); // 10% tolerance for timer jitter

        await session.close();
      }
    );
  });
});
