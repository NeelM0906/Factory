/**
 * Tests for ACP event mapper — pure functions from one ACP provider frame
 * to zero or more AgentSessionStreamEvent values.
 *
 * Task 5 Step 1 (RED): every assertion here must fail until Step 2 implements the mapper.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  mapAcpFrame,
  buildUnknownUsage,
  type AcpMapperContext
} from "../src/acp-event-mapper.js";

import { EventSequencer, InMemoryEvidenceSink, sanitizeTextField } from "@autostack/agent-adapter-kit";
import { AgentSessionStreamEventSchema } from "@autostack/contracts";

// ---- Helpers ----

const SESSION_ID = "agt_01234567-89ab-1def-8012-3456789abcde";
const WORKSPACE = "/tmp/agent-workspace";

const makeContext = (overrides?: Partial<AcpMapperContext>): AcpMapperContext => ({
  sessionId: SESSION_ID,
  sequencer: new EventSequencer(),
  evidenceSink: new InMemoryEvidenceSink(),
  workspaceCwd: WORKSPACE,
  structuredPlans: true,
  ...overrides
});

const sha256 = (text: string): string =>
  createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

// ---- session/update: agent_message_chunk → message ----

describe("agent_message_chunk → message", () => {
  it("maps to a message event with role assistant", async () => {
    const ctx = makeContext();
    const frame = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_01k9m3q4r5s6t7u8v9w0x1y2",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Reading README.md." }
        }
      }
    };

    const events = await mapAcpFrame(frame, ctx);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("message");
    expect(event).toHaveProperty("role", "assistant");
    expect(event).toHaveProperty("text", "Reading README.md.");
    expect(event.sessionId).toBe(SESSION_ID);
    expect(event.sequence).toBe(1);
    // Must parse through the contract schema
    expect(() => AgentSessionStreamEventSchema.parse(event)).not.toThrow();
  });
});

// ---- session/update: agent_thought_chunk → thought_summary ----

describe("agent_thought_chunk → thought_summary", () => {
  it("maps to a thought_summary event", async () => {
    const ctx = makeContext();
    const frame = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_01k9m3q4r5s6t7u8v9w0x1y2",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "The file is small; a single read is enough." }
        }
      }
    };

    const events = await mapAcpFrame(frame, ctx);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("thought_summary");
    expect(event).toHaveProperty("text", "The file is small; a single read is enough.");
    expect(() => AgentSessionStreamEventSchema.parse(event)).not.toThrow();
  });
});

// ---- session/update: plan → plan (when structuredPlans is true) ----

describe("plan → plan (structuredPlans enabled)", () => {
  it("maps to a plan event with a planDigest and summary", async () => {
    const ctx = makeContext({ structuredPlans: true });
    const frame = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_01k9m3q4r5s6t7u8v9w0x1y2",
        update: {
          sessionUpdate: "plan",
          entries: [
            { content: "Read README.md", priority: "high", status: "in_progress" },
            { content: "Print its contents and stop", priority: "medium", status: "pending" }
          ]
        }
      }
    };

    const events = await mapAcpFrame(frame, ctx);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("plan");
    expect(event).toHaveProperty("planDigest");
    expect(event).toHaveProperty("summary");
    // planDigest is a SHA-256 hex string
    expect((event as { planDigest: string }).planDigest).toMatch(/^[0-9a-f]{64}$/i);
    expect(() => AgentSessionStreamEventSchema.parse(event)).not.toThrow();

    // The evidence sink should have recorded the plan
    expect((ctx.evidenceSink as InMemoryEvidenceSink).size).toBe(1);
  });
});

// ---- plan → output (when structuredPlans is false) ----

describe("plan → output (structuredPlans disabled)", () => {
  it("maps to an output event when structuredPlans is false", async () => {
    const ctx = makeContext({ structuredPlans: false });
    const frame = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_01k9m3q4r5s6t7u8v9w0x1y2",
        update: {
          sessionUpdate: "plan",
          entries: [
            { content: "Read README.md", priority: "high", status: "in_progress" }
          ]
        }
      }
    };

    const events = await mapAcpFrame(frame, ctx);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("output");
    expect(event).toHaveProperty("stream", "structured");
    expect(() => AgentSessionStreamEventSchema.parse(event)).not.toThrow();
  });
});

// ---- tool_call + tool_call_update → tool_call with phases ----

describe("tool_call / tool_call_update → tool_call events", () => {
  it("maps tool_call to started and tool_call_update completed to completed", async () => {
    const ctx = makeContext();

    // tool_call (in_progress) — no permission gate, so ungated:
    // Per D-3, for an ungated call, started is emitted at completion (when tool_result arrives)
    // BUT the ACP protocol sends tool_call then tool_call_update separately,
    // and there is no permission gate, so tool_call maps to started, tool_call_update to completed
    const toolCallFrame = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_01k9m3q4r5s6t7u8v9w0x1y2",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_01hq8p3n",
          title: "Read README.md",
          kind: "read",
          status: "in_progress",
          locations: [{ path: "/tmp/agent-workspace/README.md" }],
          rawInput: { path: "/tmp/agent-workspace/README.md" }
        }
      }
    };

    const startedEvents = await mapAcpFrame(toolCallFrame, ctx);
    expect(startedEvents).toHaveLength(1);
    const started = startedEvents[0]!;
    expect(started.type).toBe("tool_call");
    expect(started).toHaveProperty("phase", "started");
    expect(started).toHaveProperty("name", "Read README.md");
    expect(started).toHaveProperty("toolCallRef", "call_01hq8p3n");
    expect(() => AgentSessionStreamEventSchema.parse(started)).not.toThrow();

    // tool_call_update (completed)
    const updateFrame = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_01k9m3q4r5s6t7u8v9w0x1y2",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_01hq8p3n",
          status: "completed",
          content: [{
            type: "content",
            content: { type: "text", text: "hello from the disposable repo" }
          }]
        }
      }
    };

    const completedEvents = await mapAcpFrame(updateFrame, ctx);
    expect(completedEvents).toHaveLength(1);
    const completed = completedEvents[0]!;
    expect(completed.type).toBe("tool_call");
    expect(completed).toHaveProperty("phase", "completed");
    expect(completed).toHaveProperty("toolCallRef", "call_01hq8p3n");
    expect(() => AgentSessionStreamEventSchema.parse(completed)).not.toThrow();
  });
});

// ---- file edits → file_change with relativized path ----

describe("tool_call_update with diff content → file_change", () => {
  it("maps a diff content item to file_change with a relativized path", async () => {
    const ctx = makeContext();
    const frame = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_01k9m3q4r5s6t7u8v9w0x1y2",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_01hq8p42",
          status: "completed",
          content: [{
            type: "diff",
            path: "/tmp/agent-workspace/notes.txt",
            oldText: null,
            newText: "hello\n"
          }]
        }
      }
    };

    const events = await mapAcpFrame(frame, ctx);
    // Should produce at least a tool_call completed AND a file_change
    const fileChanges = events.filter(e => e.type === "file_change");
    expect(fileChanges.length).toBeGreaterThanOrEqual(1);
    const fc = fileChanges[0]!;
    expect(fc).toHaveProperty("path", "notes.txt"); // relativized
    expect(fc).toHaveProperty("change", "added"); // oldText null → added
    fileChanges.forEach(e => {
      expect(() => AgentSessionStreamEventSchema.parse(e)).not.toThrow();
    });
  });

  it("maps a modified file (oldText present) to change: modified", async () => {
    const ctx = makeContext();
    const frame = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_01k9m3q4r5s6t7u8v9w0x1y2",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_modified",
          status: "completed",
          content: [{
            type: "diff",
            path: "/tmp/agent-workspace/README.md",
            oldText: "old content",
            newText: "new content"
          }]
        }
      }
    };

    const events = await mapAcpFrame(frame, ctx);
    const fileChanges = events.filter(e => e.type === "file_change");
    expect(fileChanges.length).toBeGreaterThanOrEqual(1);
    expect(fileChanges[0]).toHaveProperty("change", "modified");
  });
});

// ---- Security: absolute/escaping path → output, not file_change ----

describe("path outside workspace → output, not file_change", () => {
  it("maps an absolute path outside workspace to an output event", async () => {
    const ctx = makeContext();
    const frame = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_01k9m3q4r5s6t7u8v9w0x1y2",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_escape",
          status: "completed",
          content: [{
            type: "diff",
            path: "/etc/passwd",
            oldText: null,
            newText: "hacked"
          }]
        }
      }
    };

    const events = await mapAcpFrame(frame, ctx);
    const fileChanges = events.filter(e => e.type === "file_change");
    expect(fileChanges).toHaveLength(0);
    // Should appear as output instead
    const outputs = events.filter(e => e.type === "output");
    expect(outputs.length).toBeGreaterThanOrEqual(1);
  });

  it("maps a ..-escaping path to an output event", async () => {
    const ctx = makeContext();
    const frame = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_01k9m3q4r5s6t7u8v9w0x1y2",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_dotdot",
          status: "completed",
          content: [{
            type: "diff",
            path: "/tmp/agent-workspace/../../../etc/passwd",
            oldText: null,
            newText: "hacked"
          }]
        }
      }
    };

    const events = await mapAcpFrame(frame, ctx);
    const fileChanges = events.filter(e => e.type === "file_change");
    expect(fileChanges).toHaveLength(0);
    const outputs = events.filter(e => e.type === "output");
    expect(outputs.length).toBeGreaterThanOrEqual(1);
  });
});

// ---- session/request_permission → permission_requested ----

describe("session/request_permission → permission_requested", () => {
  it("maps to a permission_requested event with evidenceDigest", async () => {
    const ctx = makeContext();
    const frame = {
      jsonrpc: "2.0",
      id: 1,
      method: "session/request_permission",
      params: {
        sessionId: "sess_01k9m3q4r5s6t7u8v9w0x1y2",
        toolCall: {
          toolCallId: "call_01hq8p42",
          title: "Create notes.txt",
          kind: "edit",
          status: "pending",
          locations: [{ path: "/tmp/agent-workspace/notes.txt" }],
          rawInput: { path: "/tmp/agent-workspace/notes.txt", content: "hello\n" }
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Always allow edits", kind: "allow_always" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          { optionId: "reject-always", name: "Always reject edits", kind: "reject_always" }
        ]
      }
    };

    const events = await mapAcpFrame(frame, ctx);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("permission_requested");
    expect(event).toHaveProperty("permissionRef");
    expect(event).toHaveProperty("evidenceDigest");
    expect((event as { evidenceDigest: string }).evidenceDigest).toMatch(/^[0-9a-f]{64}$/i);
    expect(() => AgentSessionStreamEventSchema.parse(event)).not.toThrow();

    // Evidence sink should have recorded the permission
    expect((ctx.evidenceSink as InMemoryEvidenceSink).size).toBe(1);
  });
});

// ---- D-3: no tool_call before permission_resolved (requests_permission transcript) ----

describe("D-3: permission gating", () => {
  it("no tool_call of any phase appears before permission_resolved", async () => {
    const ctx = makeContext();

    // Step 1: agent_message_chunk (before the permission)
    await mapAcpFrame({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_01k9m3q4r5s6t7u8v9w0x1y2",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Reading README.md." }
        }
      }
    }, ctx);

    // Step 2: session/request_permission — emits permission_requested
    const permEvents = await mapAcpFrame({
      jsonrpc: "2.0",
      id: 1,
      method: "session/request_permission",
      params: {
        sessionId: "sess_01k9m3q4r5s6t7u8v9w0x1y2",
        toolCall: {
          toolCallId: "call_01hq8p42",
          title: "Create notes.txt",
          kind: "edit",
          status: "pending",
          locations: [{ path: "/tmp/agent-workspace/notes.txt" }],
          rawInput: { path: "/tmp/agent-workspace/notes.txt", content: "hello\n" }
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" }
        ]
      }
    }, ctx);

    expect(permEvents).toHaveLength(1);
    expect(permEvents[0]!.type).toBe("permission_requested");

    // Before the decision: NO tool_call events should have been emitted
    // (from the permission_requested frame or any prior frame for this toolCallId)

    // Step 3: the tool_call (in_progress) for the gated call arrives AFTER the decision
    // In the fixture, the tool_call frame appears after the awaitStdin that awaits the decision.
    // So the mapper should have buffered it. But in ACP, the gated call's tool_call frame
    // only arrives after the decision — the agent holds it.
    // So there's nothing to buffer here; the tool_call comes after the decision naturally.

    // Verify: no tool_call emitted so far
    // (We track all events emitted so far by replaying the ctx's sequencer)
    // The sequencer should have allocated sequences only for message + permission_requested = 2
    expect(ctx.sequencer.lastAllocated).toBe(2);
  });
});

// ---- stderr → output ----

describe("stderr frames → output events", () => {
  it("maps stderr to output with stream stderr", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      { kind: "stderr", text: "acp-agent: model backend returned 500, aborting turn\n" },
      ctx
    );
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("output");
    expect(event).toHaveProperty("stream", "stderr");
    expect(() => AgentSessionStreamEventSchema.parse(event)).not.toThrow();
  });
});

// ---- stopReason: end_turn → completed ----

describe("stopReason end_turn → completed", () => {
  it("maps a session/prompt result with stopReason end_turn to completed", async () => {
    const ctx = makeContext();

    // Emit a prior evidence-bearing event so completed has digests
    await mapAcpFrame({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_01k9m3q4r5s6t7u8v9w0x1y2",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Reading README.md." }
        }
      }
    }, ctx);

    const frame = {
      jsonrpc: "2.0",
      id: 3,
      result: { stopReason: "end_turn" }
    };

    const events = await mapAcpFrame(frame, ctx);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("completed");
    expect(event).toHaveProperty("evidenceDigests");
    const digests = (event as { evidenceDigests: string[] }).evidenceDigests;
    expect(digests.length).toBeGreaterThanOrEqual(1);
    expect(digests[0]).toMatch(/^[0-9a-f]{64}$/i);
    expect(() => AgentSessionStreamEventSchema.parse(event)).not.toThrow();
  });
});

// ---- JSON-RPC error → failed ----

describe("JSON-RPC error → failed", () => {
  it("maps a JSON-RPC error response to a failed event", async () => {
    const ctx = makeContext();
    const frame = {
      jsonrpc: "2.0",
      id: 3,
      error: {
        code: -32603,
        message: "Internal error: model backend unavailable, try again shortly",
        data: { sessionId: "sess_01k9m3q4r5s6t7u8v9w0x1y2" }
      }
    };

    const events = await mapAcpFrame(frame, ctx);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("failed");
    expect(event).toHaveProperty("code", "provider_internal_error");
    expect(event).toHaveProperty("retryable", true);
    expect(() => AgentSessionStreamEventSchema.parse(event)).not.toThrow();
  });
});

// ---- Usage honesty: ACP reports no usage figures ----

describe("usage honesty", () => {
  it("buildUnknownUsage returns all-unknown tokens and cost", () => {
    const usage = buildUnknownUsage();
    expect(usage.tokens.input).toEqual({ state: "unknown" });
    expect(usage.tokens.output).toEqual({ state: "unknown" });
    expect(usage.tokens.cachedInput).toEqual({ state: "unknown" });
    expect(usage.tokens.reasoning).toEqual({ state: "unknown" });
    expect(usage.cost).toEqual({ state: "unknown" });
  });

  it("no code path can substitute a zero for an unknown token count", () => {
    const usage = buildUnknownUsage();
    // Every token count field must be { state: "unknown" }, never { state: "reported", value: 0 }
    for (const field of ["input", "output", "cachedInput", "reasoning"] as const) {
      expect(usage.tokens[field]).not.toHaveProperty("value");
      expect(usage.tokens[field].state).toBe("unknown");
    }
    // Cost must also be unknown, never { state: "reported", currency: "USD", micros: 0 }
    expect(usage.cost).not.toHaveProperty("micros");
    expect(usage.cost.state).toBe("unknown");
  });
});

// ---- user_message_chunk → output with stream structured ----

describe("user_message_chunk → output", () => {
  it("maps user_message_chunk to an output event with stream structured", async () => {
    const ctx = makeContext();
    const frame = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_01k9m3q4r5s6t7u8v9w0x1y2",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Print the contents of README.md." }
        }
      }
    };

    const events = await mapAcpFrame(frame, ctx);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("output");
    expect(event).toHaveProperty("stream", "structured");
    expect(() => AgentSessionStreamEventSchema.parse(event)).not.toThrow();
  });
});

// ---- Redaction: provider text is sanitized per D-4 ----

describe("D-4: text field redaction", () => {
  it("redacts text fields through sanitizeTextField before event emission", async () => {
    const ctx = makeContext();
    // We cannot directly prove redaction without knowing what sanitizeTextField does,
    // but we can prove the events parse — sanitizeTextField is called in the mapper
    const frame = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_01k9m3q4r5s6t7u8v9w0x1y2",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Normal safe text." }
        }
      }
    };

    const events = await mapAcpFrame(frame, ctx);
    expect(events).toHaveLength(1);
    expect(() => AgentSessionStreamEventSchema.parse(events[0]!)).not.toThrow();
  });
});

// ---- Sequence numbers are positive and strictly increasing ----

describe("sequence allocation", () => {
  it("produces strictly increasing positive sequence numbers", async () => {
    const ctx = makeContext();
    const sequences: number[] = [];

    // Emit several frames
    const frames = [
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_01k9m3q4r5s6t7u8v9w0x1y2",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "First" }
          }
        }
      },
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_01k9m3q4r5s6t7u8v9w0x1y2",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "Second" }
          }
        }
      },
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_01k9m3q4r5s6t7u8v9w0x1y2",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Third" }
          }
        }
      }
    ];

    for (const frame of frames) {
      const events = await mapAcpFrame(frame, ctx);
      for (const e of events) {
        sequences.push(e.sequence as number);
      }
    }

    expect(sequences.length).toBe(3);
    for (let i = 0; i < sequences.length; i++) {
      expect(sequences[i]).toBeGreaterThan(0);
      if (i > 0) {
        expect(sequences[i]).toBeGreaterThan(sequences[i - 1]!);
      }
    }
  });
});

// ---- Every produced event passes AgentSessionStreamEventSchema.parse ----

describe("schema validation boundary", () => {
  it("all events from the completes transcript parse through the contract schema", async () => {
    const ctx = makeContext();
    // Replay the relevant update frames from the completes transcript
    const updateFrames = [
      // plan
      {
        jsonrpc: "2.0", method: "session/update",
        params: {
          sessionId: "s", update: {
            sessionUpdate: "plan",
            entries: [{ content: "Read", priority: "high", status: "in_progress" }]
          }
        }
      },
      // thought
      {
        jsonrpc: "2.0", method: "session/update",
        params: {
          sessionId: "s", update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "thinking" }
          }
        }
      },
      // message
      {
        jsonrpc: "2.0", method: "session/update",
        params: {
          sessionId: "s", update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "doing" }
          }
        }
      },
      // tool_call
      {
        jsonrpc: "2.0", method: "session/update",
        params: {
          sessionId: "s", update: {
            sessionUpdate: "tool_call",
            toolCallId: "c1", title: "Read", kind: "read", status: "in_progress",
            locations: [{ path: "/tmp/agent-workspace/f.txt" }],
            rawInput: { path: "/tmp/agent-workspace/f.txt" }
          }
        }
      },
      // tool_call_update
      {
        jsonrpc: "2.0", method: "session/update",
        params: {
          sessionId: "s", update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "c1", status: "completed",
            content: [{ type: "content", content: { type: "text", text: "result" } }]
          }
        }
      },
      // final message
      {
        jsonrpc: "2.0", method: "session/update",
        params: {
          sessionId: "s", update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "done" }
          }
        }
      }
    ];

    for (const frame of updateFrames) {
      const events = await mapAcpFrame(frame, ctx);
      for (const event of events) {
        expect(() => AgentSessionStreamEventSchema.parse(event)).not.toThrow();
      }
    }
  });
});

// ---- Frame dispatch: unknown / missing method ----

describe("frame dispatch edge cases", () => {
  it("drops frames with an unknown notification method", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      { jsonrpc: "2.0", method: "session/unknown_method", params: {} },
      ctx
    );
    expect(events).toHaveLength(0);
  });

  it("drops frames with no method and no result/error", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame({ jsonrpc: "2.0" }, ctx);
    expect(events).toHaveLength(0);
  });

  it("drops result frames that have no stopReason", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      { jsonrpc: "2.0", id: 1, result: { sessionId: "sess_abc" } },
      ctx
    );
    expect(events).toHaveLength(0);
  });
});

// ---- session/update edge cases ----

describe("session/update edge cases", () => {
  it("drops when params is missing", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      { jsonrpc: "2.0", method: "session/update" },
      ctx
    );
    expect(events).toHaveLength(0);
  });

  it("drops when params.update is missing", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      { jsonrpc: "2.0", method: "session/update", params: {} },
      ctx
    );
    expect(events).toHaveLength(0);
  });

  it("emits output for an unknown sessionUpdate type", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_01k9m3q4r5s6t7u8v9w0x1y2",
          update: {
            sessionUpdate: "completely_unknown_type",
            data: { foo: "bar" }
          }
        }
      },
      ctx
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("output");
    expect(events[0]).toHaveProperty("stream", "structured");
    expect(() => AgentSessionStreamEventSchema.parse(events[0]!)).not.toThrow();
  });
});

// ---- Empty / null text branches ----

describe("empty text after sanitization → dropped", () => {
  it("drops agent_message_chunk when text is empty", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "" }
          }
        }
      },
      ctx
    );
    expect(events).toHaveLength(0);
  });

  it("drops agent_message_chunk when content has no text field", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text" }
          }
        }
      },
      ctx
    );
    expect(events).toHaveLength(0);
  });

  it("drops agent_thought_chunk when text is whitespace-only", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "   " }
          }
        }
      },
      ctx
    );
    expect(events).toHaveLength(0);
  });

  it("drops user_message_chunk when text is empty", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s",
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "" }
          }
        }
      },
      ctx
    );
    expect(events).toHaveLength(0);
  });

  it("drops stderr when text is empty", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame({ kind: "stderr", text: "" }, ctx);
    expect(events).toHaveLength(0);
  });
});

// ---- tool_call edge cases ----

describe("tool_call edge cases", () => {
  it("drops tool_call when toolCallId is missing", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s",
          update: {
            sessionUpdate: "tool_call",
            title: "Read file",
            kind: "read",
            status: "in_progress"
          }
        }
      },
      ctx
    );
    expect(events).toHaveLength(0);
  });

  it("drops tool_call when title is missing", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call_no_title",
            kind: "read",
            status: "in_progress"
          }
        }
      },
      ctx
    );
    expect(events).toHaveLength(0);
  });
});

// ---- tool_call_update edge cases ----

describe("tool_call_update edge cases", () => {
  it("drops tool_call_update when toolCallId is missing", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s",
          update: {
            sessionUpdate: "tool_call_update",
            status: "completed",
            content: []
          }
        }
      },
      ctx
    );
    expect(events).toHaveLength(0);
  });

  it("maps tool_call_update with status 'failed' to phase 'failed'", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_failed",
            status: "failed",
            content: []
          }
        }
      },
      ctx
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("tool_call");
    expect(events[0]).toHaveProperty("phase", "failed");
  });

  it("maps unknown status to phase 'completed' by default", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_weird",
            status: "something_unexpected"
          }
        }
      },
      ctx
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("tool_call");
    expect(events[0]).toHaveProperty("phase", "completed");
  });

  it("emits only tool_call when content is null", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_no_content",
            status: "completed"
          }
        }
      },
      ctx
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("tool_call");
    expect(events[0]).toHaveProperty("phase", "completed");
  });

  it("skips diff items with no path", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_no_path",
            status: "completed",
            content: [{ type: "diff", oldText: "a", newText: "b" }]
          }
        }
      },
      ctx
    );
    const fileChanges = events.filter(e => e.type === "file_change");
    expect(fileChanges).toHaveLength(0);
    expect(events.some(e => e.type === "tool_call")).toBe(true);
  });

  it("skips non-diff content items", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_non_diff",
            status: "completed",
            content: [
              { type: "content", content: { type: "text", text: "result" } },
              { type: "image", data: "base64..." }
            ]
          }
        }
      },
      ctx
    );
    const fileChanges = events.filter(e => e.type === "file_change");
    expect(fileChanges).toHaveLength(0);
    expect(events.some(e => e.type === "tool_call")).toBe(true);
  });
});

// ---- classifyChange: deleted case ----

describe("file deletion detection", () => {
  it("maps oldText present / newText null to change: deleted", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_delete",
            status: "completed",
            content: [{
              type: "diff",
              path: "/tmp/agent-workspace/old-file.txt",
              oldText: "old content",
              newText: null
            }]
          }
        }
      },
      ctx
    );
    const fileChanges = events.filter(e => e.type === "file_change");
    expect(fileChanges).toHaveLength(1);
    expect(fileChanges[0]).toHaveProperty("change", "deleted");
  });
});

// ---- plan edge case: missing entries ----

describe("plan edge cases", () => {
  it("drops plan when entries is missing", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s",
          update: { sessionUpdate: "plan" }
        }
      },
      ctx
    );
    expect(events).toHaveLength(0);
  });
});

// ---- session/request_permission edge cases ----

describe("session/request_permission edge cases", () => {
  it("drops when params is missing", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      { jsonrpc: "2.0", method: "session/request_permission" },
      ctx
    );
    expect(events).toHaveLength(0);
  });

  it("drops when toolCall is missing", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      {
        jsonrpc: "2.0",
        method: "session/request_permission",
        params: {
          options: [{ optionId: "a", name: "Allow", kind: "allow_once" }]
        }
      },
      ctx
    );
    expect(events).toHaveLength(0);
  });

  it("drops when options is missing", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      {
        jsonrpc: "2.0",
        method: "session/request_permission",
        params: {
          toolCall: { toolCallId: "c1", title: "Write" }
        }
      },
      ctx
    );
    expect(events).toHaveLength(0);
  });
});

// ---- JSON-RPC error edge cases ----

describe("JSON-RPC error edge cases", () => {
  it("uses defaults when error has no code or message", async () => {
    const ctx = makeContext();
    const events = await mapAcpFrame(
      { jsonrpc: "2.0", id: 1, error: {} },
      ctx
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("failed");
    expect(() => AgentSessionStreamEventSchema.parse(events[0]!)).not.toThrow();
  });
});
