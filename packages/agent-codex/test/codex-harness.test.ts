/**
 * Tests for the Codex harness.
 *
 * Uses a fixture Codex script that replays transcripts over real stdio,
 * testing the full lifecycle: start, steer, permissions, cancellation, dispose.
 */

import { describe, expect, it, afterEach } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { CodexHarness, type CodexHarnessOptions } from "../src/codex-harness.js";
import { CODEX_AUTH_VARIABLES } from "../src/codex-launch-profile.js";
import { InMemoryEvidenceSink } from "@autostack/agent-adapter-kit";
import {
  AgentInvocationRequestSchema,
  AgentCancelRequestSchema,
  AgentSteerRequestSchema,
  createId,
  type AgentInvocationRequest,
  type AgentSessionStreamEvent
} from "@autostack/contracts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_AGENT = resolve(__dirname, "fixtures/codex-agent.mjs");
const AGENT_CWD = mkdtempSync(resolve(tmpdir(), "codex-harness-"));

const uuid = (value: number): string =>
  `123e4567-e89b-42d3-a456-${String(value).padStart(12, "0")}`;

const WORKSPACE_ID = createId("workspace", uuid(1));
const RUN_ID = createId("run", uuid(2));
const STAGE_RUN_ID = createId("stageRun", uuid(3));
const SESSION_ID = createId("agentSession", uuid(4));
const DIGEST = "a".repeat(64);

const buildInvocationRequest = (
  objective: string = "Reply with the single word APPLE and nothing else."
): AgentInvocationRequest =>
  AgentInvocationRequestSchema.parse({
    schemaVersion: 1,
    idempotencyKey: `test-idem-${Date.now()}`,
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    stageRunId: STAGE_RUN_ID,
    agentSessionId: SESSION_ID,
    adapterId: "codex/app-server",
    objective,
    cwd: AGENT_CWD,
    inputEvidenceDigests: []
  });

const createAppServerHarness = (
  transcript: string,
  options?: Partial<CodexHarnessOptions>
): CodexHarness => {
  return CodexHarness.create({
    executable: process.execPath,
    args: [FIXTURE_AGENT, transcript],
    cwd: AGENT_CWD,
    evidenceSink: new InMemoryEvidenceSink(),
    descriptor: {
      schemaVersion: 1,
      adapterId: "codex/app-server",
      kind: "codex",
      displayName: "Codex (app-server)",
      capabilities: {
        resume: true,
        steering: true,
        permissions: true,
        structuredPlans: false
      }
    },
    providerAuthVariables: [...CODEX_AUTH_VARIABLES],
    runtimeLimitMs: 10_000,
    progressTimeoutMs: 10_000,
    terminationGraceMs: 2_000,
    ...options
  });
};

const createExecHarness = (
  transcript: string,
  options?: Partial<CodexHarnessOptions>
): CodexHarness => {
  return CodexHarness.create({
    executable: process.execPath,
    args: [FIXTURE_AGENT, transcript],
    cwd: AGENT_CWD,
    evidenceSink: new InMemoryEvidenceSink(),
    descriptor: {
      schemaVersion: 1,
      adapterId: "codex/exec",
      kind: "codex",
      displayName: "Codex (exec)",
      capabilities: {
        resume: false,
        steering: false,
        permissions: false,
        structuredPlans: false
      }
    },
    providerAuthVariables: [...CODEX_AUTH_VARIABLES],
    runtimeLimitMs: 10_000,
    progressTimeoutMs: 10_000,
    terminationGraceMs: 2_000,
    ...options
  });
};

/** Collect all events from a session. */
const collectEvents = async (
  harness: CodexHarness,
  request: AgentInvocationRequest
): Promise<AgentSessionStreamEvent[]> => {
  const events: AgentSessionStreamEvent[] = [];
  for await (const event of harness.start(request)) {
    events.push(event);
  }
  return events;
};

describe("codex-harness", () => {
  let harness: CodexHarness;

  afterEach(async () => {
    if (harness != null) {
      await harness.dispose();
    }
  });

  describe("start lifecycle", () => {
    it("produces started, message, usage, and completed events from completes transcript", async () => {
      harness = createAppServerHarness("codex-completes");
      const events = await collectEvents(harness, buildInvocationRequest());

      const types = events.map((e) => e.type);
      expect(types).toContain("started");
      expect(types).toContain("message");
      expect(types).toContain("usage");
      expect(types).toContain("completed");
    });

    it("sets the provider session ref from thread/start response", async () => {
      harness = createAppServerHarness("codex-completes");
      const events = await collectEvents(harness, buildInvocationRequest());

      const started = events.find((e) => e.type === "started");
      expect(started).toBeDefined();
      if (started?.type === "started") {
        expect(started.providerSessionRef).toBe("01a04587-ce2e-7ca3-8e9e-ed05d8c37760");
      }
    });

    it("sets correct sessionId on all events", async () => {
      harness = createAppServerHarness("codex-completes");
      const events = await collectEvents(harness, buildInvocationRequest());

      for (const event of events) {
        expect(event.sessionId).toBe(SESSION_ID);
      }
    });

    it("produces strictly increasing sequence numbers", async () => {
      harness = createAppServerHarness("codex-completes");
      const events = await collectEvents(harness, buildInvocationRequest());

      let prev = 0;
      for (const event of events) {
        expect(event.sequence).toBeGreaterThan(prev);
        prev = event.sequence;
      }
    });
  });

  describe("failure handling", () => {
    it("produces a failed event from the error transcript", async () => {
      harness = createAppServerHarness("codex-fails");
      const events = await collectEvents(harness, buildInvocationRequest());

      const failed = events.find((e) => e.type === "failed");
      expect(failed).toBeDefined();
      if (failed?.type === "failed") {
        expect(failed.code).toBe("provider_execution_error");
        expect(failed.retryable).toBe(true);
      }
      expect(events.some((e) => e.type === "completed")).toBe(false);
    });
  });

  describe("interruption (D-2)", () => {
    it("produces an interrupted event when process is killed after evidence", async () => {
      harness = createAppServerHarness("codex-interrupted");
      const events = await collectEvents(harness, buildInvocationRequest());

      const interrupted = events.find((e) => e.type === "interrupted");
      expect(interrupted).toBeDefined();
      if (interrupted?.type === "interrupted") {
        expect(interrupted.retryable).toBe(true);
        expect(interrupted.evidenceDigests.length).toBeGreaterThan(0);
      }
      expect(events.some((e) => e.type === "completed")).toBe(false);
      expect(events.some((e) => e.type === "failed")).toBe(false);
    });
  });

  describe("steering (D-7)", () => {
    it("rejects steer on exec profile", async () => {
      harness = createExecHarness("codex-completes");
      await expect(
        harness.steer(
          AgentSteerRequestSchema.parse({
            schemaVersion: 1,
            idempotencyKey: "steer-1",
            sessionId: SESSION_ID,
            instruction: "Continue",
            evidenceDigest: DIGEST
          })
        )
      ).rejects.toThrow(/does not support steering/);
    });
  });

  describe("cancellation", () => {
    it("produces a cancelled event when cancel is called during streaming", async () => {
      harness = createAppServerHarness("codex-pauses");
      const events: AgentSessionStreamEvent[] = [];

      const startPromise = (async () => {
        for await (const event of harness.start(buildInvocationRequest())) {
          events.push(event);
          // Cancel after the started event
          if (event.type === "started") {
            await harness.cancel(
              AgentCancelRequestSchema.parse({
                schemaVersion: 1,
                idempotencyKey: "cancel-1",
                sessionId: SESSION_ID,
                reason: "User requested cancellation"
              })
            );
          }
        }
      })();

      await startPromise;

      const cancelled = events.find((e) => e.type === "cancelled");
      expect(cancelled).toBeDefined();
      expect(events.some((e) => e.type === "completed")).toBe(false);
    });
  });

  describe("descriptor", () => {
    it("exposes the app-server descriptor", () => {
      harness = createAppServerHarness("codex-completes");
      const desc = harness.descriptor;
      expect(desc.capabilities.resume).toBe(true);
      expect(desc.capabilities.steering).toBe(true);
      expect(desc.capabilities.permissions).toBe(true);
    });

    it("exposes the exec descriptor", () => {
      harness = createExecHarness("codex-completes");
      const desc = harness.descriptor;
      expect(desc.capabilities.resume).toBe(false);
      expect(desc.capabilities.steering).toBe(false);
      expect(desc.capabilities.permissions).toBe(false);
    });

    it("has respondToPermission on app-server harness", () => {
      harness = createAppServerHarness("codex-completes");
      expect("respondToPermission" in harness).toBe(true);
    });

    it("does not have respondToPermission on exec harness", () => {
      harness = createExecHarness("codex-completes");
      expect("respondToPermission" in harness).toBe(false);
    });
  });

  describe("dispose", () => {
    it("rejects start after dispose", async () => {
      harness = createAppServerHarness("codex-completes");
      await harness.dispose();
      await expect(
        (async () => {
          for await (const _ of harness.start(buildInvocationRequest())) {
            // no-op
          }
        })()
      ).rejects.toThrow(/disposed/);
    });

    it("is idempotent", async () => {
      harness = createAppServerHarness("codex-completes");
      await harness.dispose();
      await harness.dispose(); // should not throw
    });
  });
});
