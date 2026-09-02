/**
 * Tests for the Codex event mapper.
 *
 * Replays real Codex app-server transcript notifications through the mapper
 * and verifies the output events match the contract schema and mapping rules.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  mapCodexNotification,
  type CodexMapperContext
} from "../src/codex-event-mapper.js";
import type { CodexNotification } from "../src/codex-jsonrpc.js";
import {
  EventSequencer,
  InMemoryEvidenceSink
} from "@autostack/agent-adapter-kit";
import {
  AgentSessionStreamEventSchema,
  type AgentSessionStreamEvent
} from "@autostack/contracts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const transcriptsDir = resolve(__dirname, "fixtures/transcripts");

const loadTranscript = (name: string) =>
  JSON.parse(readFileSync(resolve(transcriptsDir, `${name}.json`), "utf8"));

const SESSION_ID = "agt_11111111-2222-4333-8444-555555555555";
const PROVIDER_SESSION_REF = "01a04587-ce2e-7ca3-8e9e-ed05d8c37760";
const CWD = "/tmp/agent-workspace";

const createContext = (): CodexMapperContext => ({
  sessionId: SESSION_ID,
  providerSessionRef: PROVIDER_SESSION_REF,
  sequencer: new EventSequencer(),
  evidenceSink: new InMemoryEvidenceSink(),
  workspaceCwd: CWD
});

/** Extract notifications from a transcript's emit frames. */
const extractNotifications = (transcriptName: string): CodexNotification[] => {
  const transcript = loadTranscript(transcriptName);
  const notifications: CodexNotification[] = [];

  for (const frame of transcript.frames) {
    if (frame.kind !== "emit") continue;
    const value = frame.value as Record<string, unknown>;
    // Notifications have "method" but no "id" (or have both for server requests)
    if ("method" in value && typeof value.method === "string") {
      const notification: CodexNotification = {
        method: value.method,
        params: (value.params ?? {}) as Record<string, unknown>,
        ...(typeof value.emittedAtMs === "number"
          ? { emittedAtMs: value.emittedAtMs }
          : {})
      };
      notifications.push(notification);
    }
  }

  return notifications;
};

/** Map all notifications through the mapper. */
const mapAllNotifications = async (
  transcriptName: string
): Promise<AgentSessionStreamEvent[]> => {
  const notifications = extractNotifications(transcriptName);
  const ctx = createContext();
  const events: AgentSessionStreamEvent[] = [];

  for (const notification of notifications) {
    const mapped = await mapCodexNotification(notification, ctx);
    events.push(...mapped);
  }

  return events;
};

describe("codex-event-mapper", () => {
  describe("completes transcript", () => {
    it("maps agentMessage delta to a message event with assistant role", async () => {
      const events = await mapAllNotifications("codex-completes");
      const messages = events.filter((e) => e.type === "message");
      expect(messages.length).toBeGreaterThan(0);
      const msg = messages[0]!;
      if (msg.type === "message") {
        expect(msg.role).toBe("assistant");
        expect(msg.text).toBe("APPLE");
      }
    });

    it("maps agentMessage completed to a message event", async () => {
      const events = await mapAllNotifications("codex-completes");
      const messages = events.filter((e) => e.type === "message");
      // Both the delta and the completed agentMessage produce messages
      expect(messages.length).toBeGreaterThanOrEqual(2);
    });

    it("maps thread/tokenUsage/updated to a usage event", async () => {
      const events = await mapAllNotifications("codex-completes");
      const usageEvents = events.filter((e) => e.type === "usage");
      expect(usageEvents.length).toBeGreaterThan(0);
    });

    it("does not produce completed (harness's job)", async () => {
      const events = await mapAllNotifications("codex-completes");
      expect(events.some((e) => e.type === "completed")).toBe(false);
    });

    it("produces strictly increasing sequence numbers", async () => {
      const events = await mapAllNotifications("codex-completes");
      let prev = 0;
      for (const event of events) {
        expect(event.sequence).toBeGreaterThan(prev);
        prev = event.sequence;
      }
    });

    it("validates all events through the contract schema", async () => {
      const events = await mapAllNotifications("codex-completes");
      for (const event of events) {
        expect(AgentSessionStreamEventSchema.parse(event)).toEqual(event);
      }
    });
  });

  describe("usage honesty", () => {
    it("reports all four token figures from tokenUsage and unknown cost", async () => {
      const events = await mapAllNotifications("codex-completes");
      const usage = events.find((e) => e.type === "usage");
      expect(usage).toBeDefined();
      if (usage?.type === "usage") {
        // Codex reports all token figures
        expect(usage.tokens.input.state).toBe("reported");
        expect(usage.tokens.output.state).toBe("reported");
        expect(usage.tokens.cachedInput.state).toBe("reported");
        expect(usage.tokens.reasoning.state).toBe("reported");
        // Codex never reports cost
        expect(usage.cost.state).toBe("unknown");
      }
    });

    it("never fabricates a zero for unknown figures", async () => {
      const events = await mapAllNotifications("codex-completes");
      const usageEvents = events.filter((e) => e.type === "usage");
      for (const u of usageEvents) {
        if (u.type !== "usage") continue;
        if (u.cost.state === "unknown") {
          expect("micros" in u.cost).toBe(false);
        }
      }
    });
  });

  describe("fails transcript", () => {
    it("produces a failed event from the error notification", async () => {
      const events = await mapAllNotifications("codex-fails");
      const failed = events.find((e) => e.type === "failed");
      expect(failed).toBeDefined();
      if (failed?.type === "failed") {
        expect(failed.code).toBe("provider_execution_error");
        expect(failed.retryable).toBe(true);
      }
    });

    it("does not produce a completed event", async () => {
      const events = await mapAllNotifications("codex-fails");
      expect(events.some((e) => e.type === "completed")).toBe(false);
    });
  });

  describe("requests_permission transcript", () => {
    it("produces a permission_requested event from the approval request", async () => {
      const events = await mapAllNotifications("codex-requests_permission");
      const perm = events.find((e) => e.type === "permission_requested");
      expect(perm).toBeDefined();
      if (perm?.type === "permission_requested") {
        expect(perm.permissionRef).toBe("exec-55f127bd-6d0e-4a86-98e2-1cf5f2d6e0b4");
        expect(perm.summary.length).toBeGreaterThan(0);
        expect(perm.evidenceDigest.length).toBe(64);
      }
    });

    it("maps commandExecution started to tool_call started", async () => {
      const events = await mapAllNotifications("codex-requests_permission");
      const toolStarted = events.filter(
        (e) => e.type === "tool_call" && "phase" in e && e.phase === "started"
      );
      expect(toolStarted.length).toBeGreaterThan(0);
    });

    it("maps commandExecution completed to tool_call completed", async () => {
      const events = await mapAllNotifications("codex-requests_permission");
      const toolCompleted = events.filter(
        (e) => e.type === "tool_call" && "phase" in e && e.phase === "completed"
      );
      expect(toolCompleted.length).toBeGreaterThan(0);
    });

    it("maps fileChange to file_change event", async () => {
      const events = await mapAllNotifications("codex-requests_permission");
      const fileChanges = events.filter((e) => e.type === "file_change");
      expect(fileChanges.length).toBeGreaterThan(0);
      if (fileChanges[0]?.type === "file_change") {
        expect(fileChanges[0].path).toBe("codexnotes.txt");
        expect(fileChanges[0].change).toBe("added");
      }
    });
  });

  describe("dropped notification types", () => {
    it("produces no events from thread/started", async () => {
      const ctx = createContext();
      const events = await mapCodexNotification(
        { method: "thread/started", params: {} },
        ctx
      );
      expect(events).toHaveLength(0);
    });

    it("produces no events from turn/completed", async () => {
      const ctx = createContext();
      const events = await mapCodexNotification(
        { method: "turn/completed", params: {} },
        ctx
      );
      expect(events).toHaveLength(0);
    });

    it("produces no events from warning", async () => {
      const ctx = createContext();
      const events = await mapCodexNotification(
        { method: "warning", params: { message: "test" } },
        ctx
      );
      expect(events).toHaveLength(0);
    });

    it("produces no events from unknown methods", async () => {
      const ctx = createContext();
      const events = await mapCodexNotification(
        { method: "some/unknown/method", params: {} },
        ctx
      );
      expect(events).toHaveLength(0);
    });
  });
});
