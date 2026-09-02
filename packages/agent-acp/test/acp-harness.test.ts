/**
 * Tests for the ACP harness — the AgentHarnessPort implementation that composes
 * sequencer, mapper, classifier, and child session.
 *
 * Task 5 Step 3 (RED): these tests must fail until Step 4 implements the harness.
 */

import { describe, expect, it, afterEach } from "vitest";

import {
  AcpHarness,
  type AcpHarnessOptions
} from "../src/acp-harness.js";
import { InMemoryEvidenceSink } from "@autostack/agent-adapter-kit";

import {
  createIdFactory,
  AgentInvocationRequestSchema,
  AgentSteerRequestSchema,
  AgentCancelRequestSchema,
  AgentResumeRequestSchema,
  type AgentInvocationRequest,
  type AgentSteerRequest,
  type AgentCancelRequest,
  type AgentResumeRequest,
  type AgentSessionStreamEvent
} from "@autostack/contracts";

// ---- Helpers ----

const ids = createIdFactory(() => "01234567-89ab-1def-8012-3456789abcde");
const SESSION_ID = ids.agentSession();
const DIGEST = "a".repeat(64);

const makeInvocation = (): AgentInvocationRequest =>
  AgentInvocationRequestSchema.parse({
    schemaVersion: 1,
    idempotencyKey: "idem-001",
    workspaceId: ids.workspace(),
    runId: ids.run(),
    stageRunId: ids.stageRun(),
    agentSessionId: SESSION_ID,
    adapterId: "acp/example-acp-agent/full",
    objective: "Print the contents of README.md and stop.",
    cwd: "/tmp/agent-workspace",
    inputEvidenceDigests: [],
    credentialRefIds: [],
    environment: []
  });

const makeSteer = (): AgentSteerRequest =>
  AgentSteerRequestSchema.parse({
    schemaVersion: 1,
    idempotencyKey: "steer-001",
    sessionId: SESSION_ID,
    instruction: "Now also print the file count.",
    evidenceDigest: DIGEST
  });

const makeCancel = (): AgentCancelRequest =>
  AgentCancelRequestSchema.parse({
    schemaVersion: 1,
    idempotencyKey: "cancel-001",
    sessionId: SESSION_ID,
    reason: "User requested cancellation."
  });

const makeResume = (): AgentResumeRequest =>
  AgentResumeRequestSchema.parse({
    schemaVersion: 1,
    idempotencyKey: "resume-001",
    sessionId: SESSION_ID,
    providerSessionRef: "sess_01k9m3q4r5s6t7u8v9w0x1y2",
    objective: "Continue the session.",
    inputEvidenceDigests: [DIGEST]
  });

const collectEvents = async (
  stream: AsyncIterable<AgentSessionStreamEvent>
): Promise<AgentSessionStreamEvent[]> => {
  const events: AgentSessionStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
};

// ---- Tests ----

describe("AcpHarness", () => {
  let harness: AcpHarness | undefined;

  afterEach(async () => {
    if (harness != null) {
      await harness.dispose();
      harness = undefined;
    }
  });

  describe("descriptor", () => {
    it("exposes the negotiated descriptor", () => {
      harness = AcpHarness.create({
        executable: "/usr/bin/false",
        args: [],
        cwd: "/tmp/agent-workspace",
        evidenceSink: new InMemoryEvidenceSink(),
        permissionsConfigured: true,
        structuredPlans: true
      });
      expect(harness.descriptor).toBeDefined();
      expect(harness.descriptor.kind).toBe("acp");
    });
  });

  describe("dispose", () => {
    it("is idempotent", async () => {
      harness = AcpHarness.create({
        executable: "/usr/bin/false",
        args: [],
        cwd: "/tmp/agent-workspace",
        evidenceSink: new InMemoryEvidenceSink(),
        permissionsConfigured: false,
        structuredPlans: false
      });
      await harness.dispose();
      await harness.dispose(); // no throw
    });

    it("makes subsequent operations reject", async () => {
      harness = AcpHarness.create({
        executable: "/usr/bin/false",
        args: [],
        cwd: "/tmp/agent-workspace",
        evidenceSink: new InMemoryEvidenceSink(),
        permissionsConfigured: false,
        structuredPlans: false
      });
      await harness.dispose();
      await expect(
        collectEvents(harness.start(makeInvocation()))
      ).rejects.toThrow();
    });
  });
});
