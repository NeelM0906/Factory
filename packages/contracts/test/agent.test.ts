import { describe, expect, it } from "vitest";

import {
  AgentHarnessDescriptorSchema,
  AgentInvocationRequestSchema,
  AgentSessionEventSchema
} from "../src/agent.js";

const ids = {
  workspaceId: "ws_123e4567-e89b-42d3-a456-426614174000",
  runId: "run_123e4567-e89b-42d3-a456-426614174000",
  stageRunId: "stage_123e4567-e89b-42d3-a456-426614174000",
  agentSessionId: "agt_123e4567-e89b-42d3-a456-426614174000",
  environmentId: "env_123e4567-e89b-42d3-a456-426614174000"
} as const;

describe("agent harness contracts", () => {
  it.each(["codex", "claude", "acp", "native"] as const)(
    "admits a strict %s harness descriptor",
    (kind) => {
      expect(
        AgentHarnessDescriptorSchema.parse({
          schemaVersion: 1,
          adapterId: `${kind}.local.v1`,
          kind,
          displayName: kind,
          capabilities: {
            resume: true,
            steering: true,
            permissions: true,
            structuredPlans: true
          }
        }).kind
      ).toBe(kind);
    }
  );

  it("keeps invocation portable and credentials opaque", () => {
    const request = AgentInvocationRequestSchema.parse({
      schemaVersion: 1,
      idempotencyKey: "agent-start:run:implement:1",
      ...ids,
      adapterId: "codex.local.v1",
      objective: "Implement the approved plan",
      cwd: ".",
      inputEvidenceDigests: ["a".repeat(64)],
      credentialRefIds: ["cred_123e4567-e89b-42d3-a456-426614174000"],
      environment: [{ name: "AUTOSTACK_MODE", value: "local" }]
    });

    expect(request).not.toHaveProperty("model");
    expect(request).not.toHaveProperty("apiKey");
    expect(() =>
      AgentInvocationRequestSchema.parse({ ...request, apiKey: "sk-secret-value-that-must-fail" })
    ).toThrow();
  });

  it("requires ordered, digest-backed session events", () => {
    expect(
      AgentSessionEventSchema.parse({
        schemaVersion: 1,
        sessionId: ids.agentSessionId,
        sequence: 1,
        occurredAt: "2026-08-23T12:00:00.000Z",
        type: "completed",
        evidenceDigests: ["b".repeat(64)]
      }).type
    ).toBe("completed");
    expect(() =>
      AgentSessionEventSchema.parse({
        schemaVersion: 1,
        sessionId: ids.agentSessionId,
        sequence: 0,
        occurredAt: "2026-08-23T12:00:00.000Z",
        type: "completed",
        evidenceDigests: []
      })
    ).toThrow();
  });
});
