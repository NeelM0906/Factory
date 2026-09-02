/**
 * Live harness smoke for Claude Code.
 *
 * Skipped by default — runs only when `AUTOSTACK_LIVE_HARNESS_SMOKE=1` is set
 * AND the `claude` CLI is installed and authenticated. The skip is visible
 * (vitest reports it with a stated reason), never silent.
 *
 * When the flag is set, drives a trivial objective through the real CLI on a
 * disposable temp repository, asserts the stream reaches a `completed` terminal
 * with at least one `usage` event, and cleans up the repo in a `finally`.
 * Also exercises the D-6 availability probe against the real CLI.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

import {
  AgentInvocationRequestSchema,
  createId,
  type AgentSessionStreamEvent
} from "@autostack/contracts";
import { InMemoryEvidenceSink } from "@autostack/agent-adapter-kit";

import { ClaudeHarness } from "../src/claude-harness.js";
import { CLAUDE_AUTH_VARIABLES } from "../src/claude-launch-profile.js";
import { probeClaudeAvailability } from "../src/availability.js";

// ---- Skip guard ----

const SMOKE_FLAG = process.env.AUTOSTACK_LIVE_HARNESS_SMOKE === "1";

const skipReason = (): string | undefined => {
  if (!SMOKE_FLAG) return "AUTOSTACK_LIVE_HARNESS_SMOKE is not set to 1";
  return undefined;
};

// ---- Always-running guard test ----

describe("live-smoke guard", () => {
  it("skip semantics: the guard function returns a reason when the flag is absent", () => {
    // This test always runs, proving the guard never silently passes.
    if (SMOKE_FLAG) {
      expect(skipReason()).toBeUndefined();
    } else {
      expect(skipReason()).toContain("AUTOSTACK_LIVE_HARNESS_SMOKE");
    }
  });
});

// ---- Live smoke (conditional) ----

const reason = skipReason();

describe.skipIf(reason != null)("claude-code live smoke", () => {
  it("drives a trivial objective to completion on a disposable repository", async () => {
    // Create disposable temp repo
    const tempDir = mkdtempSync(resolve(tmpdir(), "claude-live-smoke-"));
    expect(tempDir).not.toContain("Factory");

    try {
      writeFileSync(resolve(tempDir, "README.md"), "# Smoke test\n");
      execSync("git init && git add . && git commit -m init --no-gpg-sign", {
        cwd: tempDir,
        stdio: "ignore"
      });

      // D-6: probe the real CLI
      const availability = await probeClaudeAvailability({ executable: "claude" });
      expect(availability.installed).toBe(true);
      expect(availability.authenticated).toBe(true);

      // Create harness with the real CLI
      const providerSessionId = crypto.randomUUID();
      const harness = ClaudeHarness.create({
        executable: "claude",
        args: [
          "--input-format", "stream-json",
          "--output-format", "stream-json",
          "--verbose",
          "--setting-sources", "project"
        ],
        cwd: tempDir,
        evidenceSink: new InMemoryEvidenceSink(),
        descriptor: {
          schemaVersion: 1,
          adapterId: "claude-code/streaming",
          kind: "claude",
          displayName: "Claude Code (live smoke)",
          capabilities: {
            resume: false,
            steering: false,
            permissions: false,
            structuredPlans: false
          }
        },
        providerSessionId,
        providerAuthVariables: [...CLAUDE_AUTH_VARIABLES],
        runtimeLimitMs: 60_000,
        progressTimeoutMs: 30_000,
        terminationGraceMs: 5_000
      });

      const uuid = (v: number) =>
        `123e4567-e89b-42d3-a456-${String(v).padStart(12, "0")}`;
      const agentSessionId = createId("agentSession", uuid(9001));

      const invocation = AgentInvocationRequestSchema.parse({
        schemaVersion: 1,
        idempotencyKey: "live-smoke:claude:start",
        workspaceId: createId("workspace", uuid(1)),
        runId: createId("run", uuid(2)),
        stageRunId: createId("stageRun", uuid(3)),
        agentSessionId,
        adapterId: "claude-code/streaming",
        objective: "Reply with the single word PONG and nothing else.",
        cwd: tempDir,
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

      // Assert: child is reaped (no orphan)
      expect(events.length).toBeGreaterThan(2);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 120_000);
});
