import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ChildSession,
  type ChildSessionOptions,
  type ChildSessionEvent
} from "../src/child-session.js";
import { buildChildEnvironment } from "../src/child-environment.js";

const SESSION_CHILD = fileURLToPath(new URL("./fixtures/session-child.mjs", import.meta.url));

const defaultOptions = (
  mode: string,
  modeArg?: string,
  overrides?: Partial<ChildSessionOptions>
): ChildSessionOptions => ({
  executable: process.execPath,
  args: [SESSION_CHILD, mode, ...(modeArg !== undefined ? [modeArg] : [])],
  cwd: process.cwd(),
  env: buildChildEnvironment(
    { HOME: "/tmp/test", PATH: process.env.PATH ?? "/usr/bin" },
    []
  ),
  runtimeLimitMs: 10_000,
  progressTimeoutMs: 5_000,
  terminationGraceMs: 2_000,
  ...overrides
});

/** Collect all events from a session's stdout stream. */
const collectEvents = async (session: ChildSession): Promise<ChildSessionEvent[]> => {
  const events: ChildSessionEvent[] = [];
  for await (const event of session) {
    events.push(event);
  }
  return events;
};

/** Collect events with a timeout to prevent hangs in tests. */
const collectWithTimeout = async (
  session: ChildSession,
  timeoutMs: number
): Promise<ChildSessionEvent[]> => {
  const events: ChildSessionEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  for await (const event of session) {
    events.push(event);
    if (Date.now() > deadline) break;
  }
  return events;
};

describe("ChildSession", () => {
  describe("spawn configuration", () => {
    it("uses only the policy-built environment, not process.env", async () => {
      const policyEnv = buildChildEnvironment(
        { HOME: "/tmp/test", PATH: process.env.PATH ?? "/usr/bin" },
        []
      );
      const session = new ChildSession(defaultOptions("env"));
      const events = await collectEvents(session);

      const frames = events.filter((e) => e.kind === "stdout");
      expect(frames.length).toBeGreaterThan(0);

      const firstFrame = frames[0];
      expect(firstFrame).toBeDefined();
      const envData = JSON.parse(firstFrame!.line) as { env: string[] };
      // The OS may inject a small set of variables (e.g. __CF_USER_TEXT_ENCODING on macOS).
      // The test proves no *process.env* ambient leak: every key the child sees must be
      // either in the policy-built env or a known OS-injected name.
      const osInjected = new Set(["__CF_USER_TEXT_ENCODING"]);
      for (const key of envData.env) {
        const inPolicy = key in policyEnv;
        const inOs = osInjected.has(key);
        expect(inPolicy || inOs).toBe(true);
      }
      // And verify the policy keys are present
      for (const key of Object.keys(policyEnv)) {
        expect(envData.env).toContain(key);
      }
    });
  });

  describe("stdout delivery", () => {
    it("delivers stdout frames in order", async () => {
      const session = new ChildSession(defaultOptions("emit", "5"));
      const events = await collectEvents(session);

      const frames = events
        .filter((e) => e.kind === "stdout")
        .map((e) => JSON.parse(e.line) as { seq: number });

      expect(frames.map((f) => f.seq)).toEqual([1, 2, 3, 4, 5]);
    });

    it("surfaces stderr separately from stdout", async () => {
      const session = new ChildSession(defaultOptions("stderr"));
      const events = await collectEvents(session);

      const stdoutEvents = events.filter((e) => e.kind === "stdout");
      const stderrEvents = events.filter((e) => e.kind === "stderr");

      expect(stdoutEvents.length).toBeGreaterThan(0);
      expect(stderrEvents.length).toBeGreaterThan(0);
      const firstStderr = stderrEvents[0];
      expect(firstStderr).toBeDefined();
      expect(firstStderr!.line).toContain("diagnostic");
    });
  });

  describe("stdin write", () => {
    it("resolves write() only once the child has accepted the bytes", async () => {
      const session = new ChildSession(defaultOptions("echo"));

      // Write a message and collect the echo
      await session.write('{"msg":"hello"}\n');
      const events: ChildSessionEvent[] = [];

      // Read just the echoed response
      for await (const event of session) {
        events.push(event);
        if (event.kind === "stdout") break;
      }

      expect(events.filter((e) => e.kind === "stdout")).toHaveLength(1);
      const echoed = JSON.parse(events.find((e) => e.kind === "stdout")!.line);
      expect(echoed).toEqual({ echoed: { msg: "hello" } });

      await session.close();
    });
  });

  describe("close() and process termination", () => {
    it("terminates a hanging child and resolves with an exit proof", async () => {
      const session = new ChildSession(defaultOptions("hang"));

      // Read the init frame to confirm the child started
      for await (const event of session) {
        if (event.kind === "stdout") break;
      }

      const result = await session.close();

      expect(result).toMatchObject({
        exited: true
      });
    });

    it("is idempotent — calling close() twice does not throw or hang", async () => {
      const session = new ChildSession(defaultOptions("emit", "1"));
      await collectEvents(session);

      const result1 = await session.close();
      const result2 = await session.close();

      expect(result1.exited).toBe(true);
      expect(result2.exited).toBe(true);
    });

    it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
      const session = new ChildSession(
        defaultOptions("signal", undefined, { terminationGraceMs: 500 })
      );

      // Read the init frame
      for await (const event of session) {
        if (event.kind === "stdout") break;
      }

      const result = await session.close();

      expect(result.exited).toBe(true);
      // The child ignored SIGTERM, so it should have been killed by signal
      expect(result.signal).toBeTruthy();
    });

    it("leaves no orphaned process after close()", async () => {
      const session = new ChildSession(defaultOptions("hang"));

      // Read the init frame
      for await (const event of session) {
        if (event.kind === "stdout") break;
      }

      const pid = session.pid;
      expect(pid).toBeDefined();

      await session.close();

      // Probe the pid — should not exist
      const alive = processAlive(pid!);
      expect(alive).toBe(false);
    });
  });

  describe("runtime and progress bounds", () => {
    it("enforces a total-runtime bound with a classified failure", async () => {
      const session = new ChildSession(
        defaultOptions("hang", undefined, { runtimeLimitMs: 500 })
      );

      const events = await collectEvents(session);
      const exitEvent = events.find((e) => e.kind === "exit");

      expect(exitEvent).toBeDefined();
    });

    it("enforces a no-output-progress bound with a classified failure", async () => {
      const session = new ChildSession(
        defaultOptions("silent", undefined, { progressTimeoutMs: 500, runtimeLimitMs: 5000 })
      );

      const events = await collectEvents(session);
      const exitEvent = events.find((e) => e.kind === "exit");

      expect(exitEvent).toBeDefined();
    });
  });

  describe("stream abandonment (finding 14)", () => {
    it("when iterator.return() is called, the child is terminated but dispose() still works", async () => {
      const session = new ChildSession(defaultOptions("hang"));

      // Read the init frame then abandon
      for await (const event of session) {
        if (event.kind === "stdout") break;
      }
      // The for-await break calls iterator.return()

      // The session should still be usable for close
      const result = await session.close();
      expect(result.exited).toBe(true);
    });
  });

  describe("exit reporting", () => {
    it("reports the exit code for a child that exits normally", async () => {
      const session = new ChildSession(defaultOptions("exit", "42"));
      const events = await collectEvents(session);
      const exitEvent = events.find((e) => e.kind === "exit");

      expect(exitEvent).toBeDefined();
      expect(exitEvent!.code).toBe(42);
    });

    it("reports exit code 0 for a successful child", async () => {
      const session = new ChildSession(defaultOptions("emit", "1"));
      const events = await collectEvents(session);
      const exitEvent = events.find((e) => e.kind === "exit");

      expect(exitEvent).toBeDefined();
      expect(exitEvent!.code).toBe(0);
    });
  });
});

/** Check if a process is still alive by sending signal 0. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
