import { describe, expect, it } from "vitest";

import {
  AgentHarnessDescriptorSchema,
  AgentHarnessProfileSchema,
  AgentInvocationRequestSchema,
  AgentPermissionRequestSchema,
  AgentSessionDetailEventSchema,
  AgentSessionEventSchema,
  AgentSessionStreamEventSchema,
  admitAgentPermissionResponse,
  type AgentHarnessPort,
  type AgentPermissionOptionKind,
  type AgentSessionStreamEvent
} from "../src/agent.js";

const ids = {
  workspaceId: "ws_123e4567-e89b-42d3-a456-426614174000",
  runId: "run_123e4567-e89b-42d3-a456-426614174000",
  stageRunId: "stage_123e4567-e89b-42d3-a456-426614174000",
  agentSessionId: "agt_123e4567-e89b-42d3-a456-426614174000",
  environmentId: "env_123e4567-e89b-42d3-a456-426614174000"
} as const;

const approvalId = "apr_123e4567-e89b-42d3-a456-426614174000";
const digest = (character: string): string => character.repeat(64);
const eventContext = {
  schemaVersion: 1 as const,
  sessionId: ids.agentSessionId,
  occurredAt: "2026-08-23T12:00:00.000Z"
};
const capabilities = {
  resume: true,
  steering: true,
  permissions: true,
  structuredPlans: true
} as const;
const harnessProfile = () => ({
  schemaVersion: 1 as const,
  descriptor: {
    schemaVersion: 1 as const,
    adapterId: "claude.local.v1",
    kind: "claude" as const,
    displayName: "Claude Code",
    capabilities: { ...capabilities }
  },
  selection: {
    modelSelection: true,
    reasoningSelection: true,
    permissionModes: ["ask", "accept-edits"]
  },
  availability: {
    installed: true,
    authenticated: true,
    checkedAt: "2026-08-23T12:00:00.000Z"
  }
});
const permissionRequest = () => ({
  schemaVersion: 1 as const,
  sessionId: ids.agentSessionId,
  permissionRef: "perm.write.src",
  summary: "Write files under src/",
  evidenceDigest: digest("c"),
  options: [
    { optionId: "allow-once", kind: "allow_once" as const, label: "Allow once" },
    { optionId: "deny-once", kind: "deny_once" as const, label: "Deny" }
  ],
  requestedAt: "2026-08-23T12:00:00.000Z"
});
const permissionResponse = () => ({
  schemaVersion: 1 as const,
  idempotencyKey: "agent-permission:run:implement:1",
  sessionId: ids.agentSessionId,
  permissionRef: "perm.write.src",
  approvalId,
  selectedOptionId: "allow-once",
  evidenceDigest: digest("c"),
  decidedAt: "2026-08-23T12:00:05.000Z"
});

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

  it("requires a failure code that survives workflow-failure normalization", () => {
    const failure = {
      schemaVersion: 1,
      sessionId: ids.agentSessionId,
      sequence: 4,
      occurredAt: "2026-08-23T12:00:00.000Z",
      type: "failed",
      message: "The adapter exited before finishing",
      retryable: true
    };
    expect(AgentSessionEventSchema.parse({ ...failure, code: "provider_rate_limited" }).type).toBe(
      "failed"
    );
    expect(() =>
      AgentSessionEventSchema.parse({ ...failure, code: "provider.rate_limited" })
    ).toThrow();
    expect(() => AgentSessionEventSchema.parse({ ...failure, code: "-32601" })).toThrow();
    expect(() =>
      AgentSessionEventSchema.parse({ ...failure, code: "Provider_Rate_Limited" })
    ).toThrow();
  });
});

describe("agent harness profile contracts", () => {
  it("declares model, reasoning, and permission-mode selection alongside the descriptor", () => {
    const profile = AgentHarnessProfileSchema.parse(harnessProfile());
    expect(profile.selection.modelSelection).toBe(true);
    expect(profile.selection.reasoningSelection).toBe(true);
    expect(profile.selection.permissionModes).toEqual(["ask", "accept-edits"]);
  });

  it("reports installed and authenticated status distinctly", () => {
    const base = harnessProfile();
    const notInstalled = AgentHarnessProfileSchema.parse({
      ...base,
      availability: { ...base.availability, installed: false, authenticated: false }
    });
    expect(notInstalled.availability.installed).toBe(false);
    expect(notInstalled.availability.authenticated).toBe(false);

    expect(() =>
      AgentHarnessProfileSchema.parse({
        ...base,
        availability: { ...base.availability, installed: false, authenticated: true }
      })
    ).toThrow();
  });

  it("keeps unsupported capabilities visibly unavailable", () => {
    const base = harnessProfile();
    expect(
      AgentHarnessProfileSchema.parse({
        ...base,
        descriptor: {
          ...base.descriptor,
          capabilities: { ...capabilities, permissions: false }
        },
        selection: { ...base.selection, permissionModes: [] }
      }).selection.permissionModes
    ).toEqual([]);
    expect(() =>
      AgentHarnessProfileSchema.parse({
        ...base,
        descriptor: {
          ...base.descriptor,
          capabilities: { ...capabilities, permissions: false }
        }
      })
    ).toThrow();
  });

  it("rejects a duplicated permission mode", () => {
    const base = harnessProfile();
    expect(() =>
      AgentHarnessProfileSchema.parse({
        ...base,
        selection: { ...base.selection, permissionModes: ["ask", "ask"] }
      })
    ).toThrow();
  });
});

describe("agent permission round trip", () => {
  it("names every permission option kind through an exported type", () => {
    const kinds: readonly AgentPermissionOptionKind[] = [
      "allow_once",
      "allow_always",
      "deny_once",
      "deny_always"
    ];
    expect(new Set(kinds).size).toBe(4);
    const request = permissionRequest();
    for (const kind of kinds) {
      expect(
        AgentPermissionRequestSchema.parse({
          ...request,
          options: [{ optionId: "chosen", kind, label: "Chosen" }, request.options[1]]
        }).options[0]?.kind
      ).toBe(kind);
    }
  });

  it("requires unique options and an explicit denial option", () => {
    expect(AgentPermissionRequestSchema.parse(permissionRequest()).options).toHaveLength(2);

    const request = permissionRequest();
    expect(() =>
      AgentPermissionRequestSchema.parse({
        ...request,
        options: [request.options[0], request.options[0]]
      })
    ).toThrow();
    expect(() =>
      AgentPermissionRequestSchema.parse({ ...request, options: [request.options[0]] })
    ).toThrow();
  });

  it("binds a response to the request it answers", () => {
    const admitted = admitAgentPermissionResponse(permissionRequest(), permissionResponse());
    expect(admitted.response.approvalId).toBe(approvalId);

    expect(() =>
      admitAgentPermissionResponse(permissionRequest(), {
        ...permissionResponse(),
        selectedOptionId: "allow-always"
      })
    ).toThrow(/did not offer/);
    expect(() =>
      admitAgentPermissionResponse(permissionRequest(), {
        ...permissionResponse(),
        evidenceDigest: digest("d")
      })
    ).toThrow(/stale/);
    expect(() =>
      admitAgentPermissionResponse(permissionRequest(), {
        ...permissionResponse(),
        permissionRef: "perm.other"
      })
    ).toThrow(/does not answer/);
    expect(() =>
      admitAgentPermissionResponse(permissionRequest(), {
        ...permissionResponse(),
        sessionId: "agt_123e4567-e89b-42d3-a456-426614174001"
      })
    ).toThrow(/different agent session/);
  });
});

describe("normalized agent session detail events", () => {
  it.each([
    { type: "message", role: "assistant", text: "Reading the repository" },
    { type: "thought_summary", text: "Considering the failing test" },
    { type: "plan", planDigest: digest("a"), summary: "Add the missing schema" },
    { type: "tool_call", toolCallRef: "tool.read.1", name: "read_file", phase: "started" },
    { type: "file_change", path: "src/index.ts", change: "modified", diffDigest: digest("b") },
    {
      type: "permission_resolved",
      permissionRef: "perm.write.src",
      selectedOptionId: "allow-once"
    },
    {
      type: "usage",
      tokens: {
        input: { state: "reported", value: 120 },
        output: { state: "reported", value: 40 },
        cachedInput: { state: "unknown" },
        reasoning: { state: "unknown" }
      },
      cost: { state: "unknown" }
    },
    {
      type: "interrupted",
      reason: "Host daemon lost the agent process",
      retryable: true,
      evidenceDigests: [digest("e")]
    }
  ] as const)("admits a sequenced $type event", (body) => {
    const event = AgentSessionDetailEventSchema.parse({ ...eventContext, sequence: 7, ...body });
    expect(event.sequence).toBe(7);
    expect(event.type).toBe(body.type);
  });

  it("streams lifecycle and detail events through one sequence space", () => {
    expect(
      AgentSessionStreamEventSchema.parse({
        ...eventContext,
        sequence: 1,
        type: "started",
        providerSessionRef: "provider-session-1"
      }).type
    ).toBe("started");
    expect(
      AgentSessionStreamEventSchema.parse({
        ...eventContext,
        sequence: 2,
        type: "thought_summary",
        text: "Considering the failing test"
      }).type
    ).toBe("thought_summary");
    expect(() =>
      AgentSessionStreamEventSchema.parse({ ...eventContext, sequence: 0, type: "cancelled" })
    ).toThrow();
  });

  it("requires an interrupted event to carry the evidence it did produce", () => {
    const interrupted = {
      ...eventContext,
      sequence: 8,
      type: "interrupted",
      reason: "Host daemon lost the agent process",
      retryable: true
    };
    expect(
      AgentSessionDetailEventSchema.parse({ ...interrupted, evidenceDigests: ["e".repeat(64)] })
        .type
    ).toBe("interrupted");
    expect(() =>
      AgentSessionDetailEventSchema.parse({ ...interrupted, evidenceDigests: [] })
    ).toThrow();
  });

  it("rejects file changes outside the managed workspace", () => {
    expect(() =>
      AgentSessionDetailEventSchema.parse({
        ...eventContext,
        sequence: 3,
        type: "file_change",
        path: "../outside/secrets.env",
        change: "modified"
      })
    ).toThrow();
  });
});

describe("agent invocation identity", () => {
  it("optionally carries the work item the session serves", () => {
    const base = {
      schemaVersion: 1,
      idempotencyKey: "agent-invoke:run:implement:1",
      ...ids,
      adapterId: "claude.local.v1",
      objective: "Implement the approved plan.",
      cwd: "/workspace/factory",
      inputEvidenceDigests: [digest("c")]
    };
    expect(AgentInvocationRequestSchema.parse(base).workItemId).toBeUndefined();
    expect(
      AgentInvocationRequestSchema.parse({
        ...base,
        workItemId: "wi_123e4567-e89b-42d3-a456-426614174000"
      }).workItemId
    ).toBe("wi_123e4567-e89b-42d3-a456-426614174000");
    expect(() =>
      AgentInvocationRequestSchema.parse({
        ...base,
        workItemId: "run_123e4567-e89b-42d3-a456-426614174000"
      })
    ).toThrow();
  });
});

describe("agent harness port", () => {
  const invocation = () =>
    AgentInvocationRequestSchema.parse({
      schemaVersion: 1,
      idempotencyKey: "agent-invoke:run:implement:1",
      ...ids,
      adapterId: "claude.local.v1",
      objective: "Implement the approved plan.",
      cwd: "/workspace/factory",
      inputEvidenceDigests: [digest("c")]
    });

  it("carries normalized detail events, not only the lifecycle union", async () => {
    const harness: AgentHarnessPort = {
      descriptor: AgentHarnessDescriptorSchema.parse(harnessProfile().descriptor),
      async *start() {
        yield AgentSessionStreamEventSchema.parse({
          ...eventContext,
          sequence: 1,
          type: "started",
          providerSessionRef: "provider-session-1"
        });
        yield AgentSessionStreamEventSchema.parse({
          ...eventContext,
          sequence: 2,
          type: "plan",
          planDigest: digest("d"),
          summary: "Split the adapter from the transport."
        });
      },
      async *resume() {
        yield AgentSessionStreamEventSchema.parse({
          ...eventContext,
          sequence: 3,
          type: "file_change",
          path: "packages/contracts/src/agent.ts",
          change: "modified"
        });
      },
      steer: async () => undefined,
      cancel: async () => undefined
    };

    const started: AgentSessionStreamEvent[] = [];
    for await (const event of harness.start(invocation())) started.push(event);
    expect(started.map((event) => event.type)).toEqual(["started", "plan"]);
  });
});
