import {
  AgentInvocationRequestSchema,
  AgentSessionIdSchema,
  RunIdSchema,
  WorkspaceIdSchema,
  createIdFactory,
  type Actor,
  type AgentHarnessPort,
  type AgentInvocationRequest,
  type PendingDomainEvent
} from "@autostack/contracts";
import {
  createFakeAgentHarness,
  type FakeHarnessScript
} from "@autostack/domain/testing";
import { describe, expect, it } from "vitest";

import {
  runRelayedSession,
  type SessionRelayOptions
} from "../../src/stations/session-relay.js";

const NOW = "2026-08-28T12:00:00.000Z";
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174001");
const RUN_ID = RunIdSchema.parse("run_123e4567-e89b-42d3-a456-426614174002");
const AGENT_SESSION_ID = AgentSessionIdSchema.parse("agt_123e4567-e89b-42d3-a456-426614174010");
const ACTOR: Actor = { kind: "system", id: "workflow" };
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174002";
const digestOf = (seed: string): string => seed.repeat(64).slice(0, 64);

const RESULT_COMMIT = "9d8c7b6a5f4e3d2c1b0a99887766554433221100";

const harnessFor = (script: FakeHarnessScript): AgentHarnessPort =>
  createFakeAgentHarness({
    script,
    now: () => NOW,
    providerSessionRef: () => "provider-session"
  });

const invocationFor = (): AgentInvocationRequest =>
  AgentInvocationRequestSchema.parse({
    schemaVersion: 1,
    idempotencyKey: "relay-test:1:1",
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    stageRunId: createIdFactory(() => UUID).stageRun(),
    agentSessionId: AGENT_SESSION_ID,
    adapterId: "fake.agent-harness",
    objective: "Implement the approved plan.",
    cwd: ".",
    inputEvidenceDigests: [digestOf("a")]
  });

const relayOptions = (overrides: Partial<SessionRelayOptions> = {}): SessionRelayOptions => ({
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  stage: "implement",
  agentSessionId: AGENT_SESSION_ID,
  actor: ACTOR,
  correlationId: CORRELATION_ID,
  now: () => NOW,
  checkpoint: () => {},
  ...overrides
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("session relay event collection", () => {
  it("relays agent session events into agent.session_event pending events", async () => {
    const script: FakeHarnessScript = [
      { kind: "emit", event: { type: "started" } },
      {
        kind: "emit",
        event: {
          type: "output",
          stream: "structured",
          text: JSON.stringify({ resultCommit: RESULT_COMMIT, finalDiffDigest: digestOf("d"), artifactIds: [] })
        }
      },
      { kind: "emit", event: { type: "completed", evidenceDigests: [digestOf("e")] } }
    ];
    const harness = harnessFor(script);
    const result = await runRelayedSession(harness, invocationFor(), relayOptions());

    expect(result.kind).toBe("completed");
    // Three events were emitted; all should be relayed.
    expect(result.events.length).toBe(3);
    for (const event of result.events) {
      expect(event.type).toBe("agent.session_event");
      const p = event.payload as Record<string, unknown>;
      expect(p.runId).toBe(RUN_ID);
      expect(p.stage).toBe("implement");
    }
  });

  it("returns events with strictly increasing sequence numbers", async () => {
    const script: FakeHarnessScript = [
      { kind: "emit", event: { type: "started" } },
      { kind: "emit", event: { type: "completed", evidenceDigests: [digestOf("e")] } }
    ];
    const harness = harnessFor(script);
    const result = await runRelayedSession(harness, invocationFor(), relayOptions());

    const sequences = result.events.map((e) => (e.payload as Record<string, unknown>).sequence as number);
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]!).toBeGreaterThan(sequences[i - 1]!);
    }
  });

  it("captures structured output and returns it", async () => {
    const structured = { resultCommit: RESULT_COMMIT, finalDiffDigest: digestOf("d"), artifactIds: [] };
    const script: FakeHarnessScript = [
      { kind: "emit", event: { type: "started" } },
      {
        kind: "emit",
        event: { type: "output", stream: "structured", text: JSON.stringify(structured) }
      },
      { kind: "emit", event: { type: "completed", evidenceDigests: [digestOf("e")] } }
    ];
    const harness = harnessFor(script);
    const result = await runRelayedSession(harness, invocationFor(), relayOptions());

    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      expect(result.structured).toEqual(structured);
    }
  });

  it("events are collected but not committed — the station commits at stage end (F13)", async () => {
    const script: FakeHarnessScript = [
      { kind: "emit", event: { type: "started" } },
      { kind: "emit", event: { type: "completed", evidenceDigests: [digestOf("e")] } }
    ];
    const harness = harnessFor(script);
    const result = await runRelayedSession(harness, invocationFor(), relayOptions());

    // The relay returns events, it does not commit them. All events are pending domain events.
    expect(result.kind).toBe("completed");
    for (const event of result.events) {
      // PendingDomainEvent has no eventId or globalSequence — it's not yet stored.
      expect(event).not.toHaveProperty("eventId");
      expect(event).not.toHaveProperty("globalSequence");
    }
  });
});

describe("session relay failure handling", () => {
  it("returns a failed outcome with collected events when the session fails", async () => {
    const script: FakeHarnessScript = [
      { kind: "emit", event: { type: "started" } },
      {
        kind: "emit",
        event: {
          type: "failed",
          code: "provider_rate_limited",
          message: "Rate limited",
          retryable: true
        }
      }
    ];
    const harness = harnessFor(script);
    const result = await runRelayedSession(harness, invocationFor(), relayOptions());

    expect(result.kind).toBe("failed");
    // The failure event itself is also relayed.
    expect(result.events.length).toBe(2);
    const p = result.events[1]!.payload as Record<string, unknown>;
    expect((p.event as Record<string, unknown>).type).toBe("failed");
  });
});
