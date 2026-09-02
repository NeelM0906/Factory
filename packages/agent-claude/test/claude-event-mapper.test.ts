/**
 * Tests for the Claude Code event mapper.
 *
 * Replays real Task 1 transcripts through the mapper and verifies the output
 * events match the contract schema and mapping rules.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  mapClaudeFrame,
  type ClaudeMapperContext
} from "../src/claude-event-mapper.js";
import { classifyClaudeFrame } from "../src/claude-frames.js";
import {
  EventSequencer,
  InMemoryEvidenceSink,
  sanitizeTextField
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
const PROVIDER_SESSION_ID = "11111111-2222-4333-8444-555555555555";
const CWD = "/tmp/agent-workspace";

const createContext = (): ClaudeMapperContext => ({
  sessionId: SESSION_ID,
  providerSessionId: PROVIDER_SESSION_ID,
  sequencer: new EventSequencer(),
  evidenceSink: new InMemoryEvidenceSink(),
  workspaceCwd: CWD,
  structuredPlans: false
});

/** Map all emit frames from a transcript through the mapper. */
const mapAllFrames = async (
  transcriptName: string
): Promise<AgentSessionStreamEvent[]> => {
  const transcript = loadTranscript(transcriptName);
  const ctx = createContext();
  const events: AgentSessionStreamEvent[] = [];

  for (const frame of transcript.frames) {
    if (frame.kind !== "emit") continue;
    const mapped = await mapClaudeFrame(frame.value, ctx);
    events.push(...mapped);
  }

  return events;
};

describe("claude-event-mapper", () => {
  describe("completes transcript", () => {
    it("produces a started event from system/init", async () => {
      const events = await mapAllFrames("claude-completes");
      const started = events.find((e) => e.type === "started");
      expect(started).toBeDefined();
      expect(started!.type).toBe("started");
      if (started!.type === "started") {
        expect(started!.providerSessionRef).toBe(PROVIDER_SESSION_ID);
      }
    });

    it("maps assistant text blocks to message events", async () => {
      const events = await mapAllFrames("claude-completes");
      const messages = events.filter((e) => e.type === "message");
      expect(messages.length).toBeGreaterThan(0);
      const firstMsg = messages[0]!;
      if (firstMsg.type === "message") {
        expect(firstMsg.role).toBe("assistant");
        expect(firstMsg.text.length).toBeGreaterThan(0);
      }
    });

    it("maps assistant tool_use blocks to tool_call started events", async () => {
      const events = await mapAllFrames("claude-completes");
      const toolCalls = events.filter(
        (e) => e.type === "tool_call" && "phase" in e && e.phase === "started"
      );
      expect(toolCalls.length).toBeGreaterThan(0);
    });

    it("maps user tool_result to tool_call completed events", async () => {
      const events = await mapAllFrames("claude-completes");
      const completed = events.filter(
        (e) => e.type === "tool_call" && "phase" in e && e.phase === "completed"
      );
      expect(completed.length).toBeGreaterThan(0);
    });

    it("maps result to usage event (completed is the harness's job)", async () => {
      const events = await mapAllFrames("claude-completes");
      // result is a TURN boundary, not session terminal — mapper emits usage only
      const completedEvents = events.filter((e) => e.type === "completed");
      expect(completedEvents).toHaveLength(0);

      const usageEvents = events.filter((e) => e.type === "usage");
      expect(usageEvents.length).toBeGreaterThan(0);
    });

    it("produces strictly increasing sequence numbers", async () => {
      const events = await mapAllFrames("claude-completes");
      let prev = 0;
      for (const event of events) {
        expect(event.sequence).toBeGreaterThan(prev);
        prev = event.sequence;
      }
    });

    it("sets the correct session id on all events", async () => {
      const events = await mapAllFrames("claude-completes");
      for (const event of events) {
        expect(event.sessionId).toBe(SESSION_ID);
      }
    });

    it("validates all events through the contract schema", async () => {
      const events = await mapAllFrames("claude-completes");
      for (const event of events) {
        expect(AgentSessionStreamEventSchema.parse(event)).toEqual(event);
      }
    });
  });

  describe("usage honesty", () => {
    it("reports per-message usage with unknown reasoning and unknown cost", async () => {
      const events = await mapAllFrames("claude-completes");
      const usageEvents = events.filter((e) => e.type === "usage");

      // Per-message usage events from assistant frames
      const perMessage = usageEvents.filter((e) => {
        if (e.type !== "usage") return false;
        // Per-message usage has unknown reasoning and unknown cost
        return e.tokens.reasoning.state === "unknown" && e.cost.state === "unknown";
      });
      expect(perMessage.length).toBeGreaterThan(0);

      // Verify no path fabricates a zero
      for (const u of perMessage) {
        if (u.type !== "usage") continue;
        if (u.tokens.input.state === "reported") {
          expect(typeof u.tokens.input.value).toBe("number");
        }
        if (u.tokens.output.state === "reported") {
          expect(typeof u.tokens.output.value).toBe("number");
        }
      }
    });

    it("reports result usage with reported cost when total_cost_usd is present", async () => {
      const events = await mapAllFrames("claude-completes");
      const usageEvents = events.filter((e) => e.type === "usage");

      // Result-derived usage has reported cost
      const resultUsage = usageEvents.find((e) => {
        if (e.type !== "usage") return false;
        return e.cost.state === "reported";
      });
      expect(resultUsage).toBeDefined();
      if (resultUsage?.type === "usage" && resultUsage.cost.state === "reported") {
        expect(resultUsage.cost.currency).toBe("USD");
        expect(resultUsage.cost.micros).toBeGreaterThan(0);
      }
    });

    it("never fabricates a zero for unknown figures", async () => {
      const events = await mapAllFrames("claude-completes");
      const usageEvents = events.filter((e) => e.type === "usage");
      for (const u of usageEvents) {
        if (u.type !== "usage") continue;
        // Each token field is either "reported" with a value or "unknown" with no value
        for (const field of [u.tokens.input, u.tokens.output, u.tokens.cachedInput, u.tokens.reasoning] as const) {
          if (field.state === "unknown") {
            expect("value" in field).toBe(false);
          }
        }
        if (u.cost.state === "unknown") {
          expect("micros" in u.cost).toBe(false);
        }
      }
    });
  });

  describe("fails transcript", () => {
    it("does not produce a completed event", async () => {
      const events = await mapAllFrames("claude-fails");
      expect(events.some((e) => e.type === "completed")).toBe(false);
    });

    it("produces a failed event from the error result", async () => {
      const events = await mapAllFrames("claude-fails");
      const failed = events.find((e) => e.type === "failed");
      expect(failed).toBeDefined();
      if (failed?.type === "failed") {
        expect(failed.retryable).toBeDefined();
      }
    });
  });

  describe("requests_permission transcript", () => {
    it("produces a permission_requested event from the JSON-RPC frame", async () => {
      const events = await mapAllFrames("claude-requests_permission");
      const perm = events.find((e) => e.type === "permission_requested");
      expect(perm).toBeDefined();
      if (perm?.type === "permission_requested") {
        expect(perm.permissionRef).toBe("toolu_01ABN8frqqE4AY1GFpqWqqjq");
        expect(perm.summary.length).toBeGreaterThan(0);
      }
    });
  });

  describe("dropped frame types", () => {
    it("produces no events from rate_limit_event", async () => {
      const ctx = createContext();
      const events = await mapClaudeFrame({ type: "rate_limit_event" }, ctx);
      expect(events).toHaveLength(0);
    });

    it("produces no events from system/task_summary", async () => {
      const ctx = createContext();
      const events = await mapClaudeFrame(
        { type: "system", subtype: "task_summary", detail: "...", uuid: "x", session_id: "s" },
        ctx
      );
      expect(events).toHaveLength(0);
    });

    it("produces no events from system/post_turn_summary", async () => {
      const ctx = createContext();
      const events = await mapClaudeFrame(
        { type: "system", subtype: "post_turn_summary", uuid: "x", session_id: "s" },
        ctx
      );
      expect(events).toHaveLength(0);
    });

    it("produces no events from unknown frame types (default case)", async () => {
      const ctx = createContext();
      const events = await mapClaudeFrame({ type: "future_frame_type" }, ctx);
      expect(events).toHaveLength(0);
    });
  });

  describe("safeParse failure paths", () => {
    it("returns empty when system/init frame fails parsing", async () => {
      const ctx = createContext();
      // system/init without required session_id
      const events = await mapClaudeFrame(
        { type: "system", subtype: "init" },
        ctx
      );
      expect(events).toHaveLength(0);
    });

    it("returns empty when assistant frame fails parsing", async () => {
      const ctx = createContext();
      // assistant frame without message
      const events = await mapClaudeFrame(
        { type: "assistant" },
        ctx
      );
      expect(events).toHaveLength(0);
    });

    it("returns empty when user frame fails parsing", async () => {
      const ctx = createContext();
      // user frame without message
      const events = await mapClaudeFrame(
        { type: "user" },
        ctx
      );
      expect(events).toHaveLength(0);
    });

    it("returns empty when result frame fails parsing", async () => {
      const ctx = createContext();
      // result frame without required fields
      const events = await mapClaudeFrame(
        { type: "result" },
        ctx
      );
      expect(events).toHaveLength(0);
    });

    it("returns empty when permission request frame fails parsing", async () => {
      const ctx = createContext();
      // JSON-RPC frame with wrong method
      const events = await mapClaudeFrame(
        { jsonrpc: "2.0", method: "tools/call", id: 1, params: {} },
        ctx
      );
      expect(events).toHaveLength(0);
    });
  });

  describe("assistant frame edge cases", () => {
    it("drops text blocks with empty text (sanitized to null)", async () => {
      const ctx = createContext();
      const events = await mapClaudeFrame({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "   " }]
        }
      }, ctx);
      // Empty/whitespace text sanitizes to undefined, so no message event is emitted
      const messages = events.filter((e) => e.type === "message");
      expect(messages).toHaveLength(0);
    });

    it("drops thinking blocks and other unknown block types", async () => {
      const ctx = createContext();
      const events = await mapClaudeFrame({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal reasoning" },
            { type: "server_tool_use", id: "st_1", name: "web_search" }
          ]
        }
      }, ctx);
      // Neither thinking nor server_tool_use produce events
      const messages = events.filter((e) => e.type === "message");
      const toolCalls = events.filter((e) => e.type === "tool_call");
      expect(messages).toHaveLength(0);
      expect(toolCalls).toHaveLength(0);
    });

    it("emits no usage event when assistant message has no usage", async () => {
      const ctx = createContext();
      const events = await mapClaudeFrame({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello" }]
        }
      }, ctx);
      const usageEvents = events.filter((e) => e.type === "usage");
      expect(usageEvents).toHaveLength(0);
      // Should still emit the message
      const messages = events.filter((e) => e.type === "message");
      expect(messages).toHaveLength(1);
    });

    it("reports unknown for missing token fields in per-message usage", async () => {
      const ctx = createContext();
      const events = await mapClaudeFrame({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
          usage: {}
        }
      }, ctx);
      const usageEvents = events.filter((e) => e.type === "usage");
      expect(usageEvents).toHaveLength(1);
      const usage = usageEvents[0]!;
      if (usage.type === "usage") {
        expect(usage.tokens.input.state).toBe("unknown");
        expect(usage.tokens.output.state).toBe("unknown");
        expect(usage.tokens.cachedInput.state).toBe("unknown");
        expect(usage.tokens.reasoning.state).toBe("unknown");
        expect(usage.cost.state).toBe("unknown");
      }
    });

    it("falls back to 'unknown' when tool name sanitizes to null", async () => {
      const ctx = createContext();
      const events = await mapClaudeFrame({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_123", name: "   " }]
        }
      }, ctx);
      const toolCalls = events.filter((e) => e.type === "tool_call");
      expect(toolCalls).toHaveLength(1);
      if (toolCalls[0]!.type === "tool_call") {
        expect(toolCalls[0]!.name).toBe("unknown");
      }
    });
  });

  describe("user frame edge cases", () => {
    it("skips tool_result blocks without tool_use_id", async () => {
      const ctx = createContext();
      const events = await mapClaudeFrame({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "result text" }]
        }
      }, ctx);
      const toolCalls = events.filter((e) => e.type === "tool_call");
      expect(toolCalls).toHaveLength(0);
    });

    it("maps tool_result with is_error to tool_call failed", async () => {
      const ctx = createContext();
      const events = await mapClaudeFrame({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_err", is_error: true, content: "command failed" }
          ]
        }
      }, ctx);
      const toolCalls = events.filter((e) => e.type === "tool_call");
      expect(toolCalls).toHaveLength(1);
      if (toolCalls[0]!.type === "tool_call") {
        expect(toolCalls[0]!.phase).toBe("failed");
        expect(toolCalls[0]!.toolCallRef).toBe("toolu_err");
      }
    });

    it("skips non-tool_result content blocks", async () => {
      const ctx = createContext();
      const events = await mapClaudeFrame({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "user typed something" }]
        }
      }, ctx);
      const toolCalls = events.filter((e) => e.type === "tool_call");
      expect(toolCalls).toHaveLength(0);
    });
  });

  describe("result frame edge cases", () => {
    it("reports unknown tokens and cost when result has no usage", async () => {
      const ctx = createContext();
      const events = await mapClaudeFrame({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done"
      }, ctx);
      const usageEvents = events.filter((e) => e.type === "usage");
      expect(usageEvents).toHaveLength(1);
      const usage = usageEvents[0]!;
      if (usage.type === "usage") {
        expect(usage.tokens.input.state).toBe("unknown");
        expect(usage.tokens.output.state).toBe("unknown");
        expect(usage.tokens.cachedInput.state).toBe("unknown");
        expect(usage.tokens.reasoning.state).toBe("unknown");
        expect(usage.cost.state).toBe("unknown");
      }
    });

    it("reports unknown reasoning when thinking_tokens is absent", async () => {
      const ctx = createContext();
      const events = await mapClaudeFrame({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        total_cost_usd: 0.01,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 10
        }
      }, ctx);
      const usageEvents = events.filter((e) => e.type === "usage");
      expect(usageEvents).toHaveLength(1);
      const usage = usageEvents[0]!;
      if (usage.type === "usage") {
        expect(usage.tokens.input.state).toBe("reported");
        expect(usage.tokens.output.state).toBe("reported");
        expect(usage.tokens.cachedInput.state).toBe("reported");
        expect(usage.tokens.reasoning.state).toBe("unknown");
        expect(usage.cost.state).toBe("reported");
      }
    });

    it("reports unknown cost when total_cost_usd is absent", async () => {
      const ctx = createContext();
      const events = await mapClaudeFrame({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          output_tokens_details: { thinking_tokens: 10 }
        }
      }, ctx);
      const usageEvents = events.filter((e) => e.type === "usage");
      expect(usageEvents).toHaveLength(1);
      const usage = usageEvents[0]!;
      if (usage.type === "usage") {
        expect(usage.tokens.reasoning.state).toBe("reported");
        if (usage.tokens.reasoning.state === "reported") {
          expect(usage.tokens.reasoning.value).toBe(10);
        }
        expect(usage.cost.state).toBe("unknown");
      }
    });

    it("uses fallback message when result is_error with non-string result", async () => {
      const ctx = createContext();
      const events = await mapClaudeFrame({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: { error: "structured error" }
      }, ctx);
      const failed = events.find((e) => e.type === "failed");
      expect(failed).toBeDefined();
      if (failed?.type === "failed") {
        expect(failed.message).toContain("error_during_execution");
      }
    });

    it("sanitizes error result text in failed message", async () => {
      const ctx = createContext();
      const events = await mapClaudeFrame({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        result: "Max turns exceeded"
      }, ctx);
      const failed = events.find((e) => e.type === "failed");
      expect(failed).toBeDefined();
      if (failed?.type === "failed") {
        expect(failed.message).toContain("Max turns exceeded");
        expect(failed.code).toBe("provider_turn_limit");
        expect(failed.retryable).toBe(false);
      }
    });
  });
});
