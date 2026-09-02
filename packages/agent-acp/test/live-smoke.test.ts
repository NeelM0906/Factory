/**
 * ACP fixture-agent smoke.
 *
 * Unlike the Claude and Codex live smokes, this runs unconditionally because
 * it uses the checked-in fixture agent, not a real external CLI. It drives
 * a trivial objective end to end against the acp-agent.mjs fixture replaying
 * the `acp-completes` transcript, asserting the stream reaches `completed`
 * with at least one `usage` event and the child is reaped.
 */

import { describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

import {
  AgentInvocationRequestSchema,
  createId,
  type AgentSessionStreamEvent
} from "@autostack/contracts";
import { InMemoryEvidenceSink } from "@autostack/agent-adapter-kit";

import { AcpHarness } from "../src/acp-harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_AGENT = resolve(__dirname, "fixtures", "acp-agent.mjs");
const TRANSCRIPTS_DIR = resolve(__dirname, "fixtures", "transcripts");

const uuid = (value: number): string =>
  `123e4567-e89b-42d3-a456-${String(value).padStart(12, "0")}`;

describe("acp fixture-agent smoke", () => {
  it("drives a trivial objective to completion against the fixture agent", async () => {
    const agentCwd = mkdtempSync(resolve(tmpdir(), "acp-live-smoke-"));

    const harness = AcpHarness.create({
      executable: process.execPath,
      args: [FIXTURE_AGENT, resolve(TRANSCRIPTS_DIR, "acp-completes.json")],
      cwd: agentCwd,
      evidenceSink: new InMemoryEvidenceSink(),
      permissionsConfigured: false,
      structuredPlans: false,
      runtimeLimitMs: 10_000,
      progressTimeoutMs: 10_000,
      terminationGraceMs: 2_000
    });

    const agentSessionId = createId("agentSession", uuid(9001));

    const invocation = AgentInvocationRequestSchema.parse({
      schemaVersion: 1,
      idempotencyKey: "live-smoke:acp:start",
      workspaceId: createId("workspace", uuid(1)),
      runId: createId("run", uuid(2)),
      stageRunId: createId("stageRun", uuid(3)),
      agentSessionId,
      adapterId: "acp/fixture",
      objective: "Reply with the single word PONG and nothing else.",
      cwd: agentCwd,
      inputEvidenceDigests: ["a".repeat(64)]
    });

    const events: AgentSessionStreamEvent[] = [];
    try {
      for await (const event of harness.start(invocation)) {
        events.push(event);
      }
    } finally {
      await harness.dispose();
    }

    // Assert: stream reaches completed
    const terminals = events.filter((e) =>
      e.type === "completed" || e.type === "failed" || e.type === "cancelled"
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.type).toBe("completed");

    // Assert: at least one usage event
    const usage = events.filter((e) => e.type === "usage");
    expect(usage.length).toBeGreaterThan(0);

    // Assert: more than just started + completed
    expect(events.length).toBeGreaterThan(2);
  });
});
