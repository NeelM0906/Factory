import { describe, expect, it } from "vitest";

import {
  AgentCancelRequestSchema,
  AgentHarnessDescriptorSchema,
  AgentInvocationRequestSchema,
  AgentPermissionResponseSchema,
  AgentResumeRequestSchema,
  AgentSessionEventSchema,
  AgentSessionStreamEventSchema,
  AgentSteerRequestSchema,
  type AgentPermissionResponderPort,
  type AgentSessionStreamEvent
} from "@autostack/contracts";

import {
  createFakeAgentHarness,
  type FakeAgentHarness
} from "../src/testing/fake-agent-harness.js";
import type { FakeHarnessScript } from "../src/testing/fake-agent-harness-script.js";

const digest = (character: string): string => character.repeat(64);

const createClock = (): (() => string) => {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.UTC(2026, 7, 26, 12, 0, tick)).toISOString();
  };
};

const createProviderSessionRefs = (): (() => string) => {
  let issued = 0;
  return () => {
    issued += 1;
    return `fake.session.${issued}`;
  };
};

const invocation = AgentInvocationRequestSchema.parse({
  schemaVersion: 1,
  idempotencyKey: "fake-harness:start:1",
  workspaceId: "ws_123e4567-e89b-42d3-a456-426614174000",
  runId: "run_123e4567-e89b-42d3-a456-426614174000",
  stageRunId: "stage_123e4567-e89b-42d3-a456-426614174000",
  agentSessionId: "agt_123e4567-e89b-42d3-a456-426614174000",
  environmentId: "env_123e4567-e89b-42d3-a456-426614174000",
  adapterId: "fake.agent-harness",
  objective: "Implement the approved plan.",
  cwd: "/workspace/factory",
  inputEvidenceDigests: [digest("1")]
});

const foreignSessionId = AgentInvocationRequestSchema.parse({
  ...invocation,
  agentSessionId: "agt_123e4567-e89b-42d3-a456-426614174001"
}).agentSessionId;

const steer = AgentSteerRequestSchema.parse({
  schemaVersion: 1,
  idempotencyKey: "fake-harness:steer:1",
  sessionId: invocation.agentSessionId,
  instruction: "Prefer the smaller refactor.",
  evidenceDigest: digest("2")
});

const cancel = AgentCancelRequestSchema.parse({
  schemaVersion: 1,
  idempotencyKey: "fake-harness:cancel:1",
  sessionId: invocation.agentSessionId,
  reason: "The operator withdrew the run."
});

const resumption = AgentResumeRequestSchema.parse({
  schemaVersion: 1,
  idempotencyKey: "fake-harness:resume:1",
  sessionId: invocation.agentSessionId,
  providerSessionRef: "fake.session.1",
  objective: "Continue the approved plan.",
  inputEvidenceDigests: [digest("1")]
});

const permissionOptions = [
  { optionId: "allow-once", kind: "allow_once", label: "Allow this write" },
  { optionId: "deny-once", kind: "deny_once", label: "Deny this write" }
] as const;

const permissionResponse = AgentPermissionResponseSchema.parse({
  schemaVersion: 1,
  idempotencyKey: "fake-harness:permission:1",
  sessionId: invocation.agentSessionId,
  permissionRef: "workspace.write",
  approvalId: "apr_123e4567-e89b-42d3-a456-426614174000",
  selectedOptionId: "allow-once",
  evidenceDigest: digest("4"),
  decidedAt: "2026-08-26T12:05:00.000Z"
});

const createHarness = (
  script: FakeHarnessScript,
  descriptor?: Parameters<typeof createFakeAgentHarness>[0]["descriptor"]
) =>
  createFakeAgentHarness({
    script,
    now: createClock(),
    providerSessionRef: createProviderSessionRefs(),
    ...(descriptor === undefined ? {} : { descriptor })
  });

const collect = async (
  stream: AsyncIterable<AgentSessionStreamEvent>
): Promise<AgentSessionStreamEvent[]> => {
  const events: AgentSessionStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

const responderOf = (
  harness: FakeAgentHarness
): AgentPermissionResponderPort["respondToPermission"] => {
  const respond = harness.respondToPermission;
  if (respond === undefined) {
    throw new TypeError("This harness declares permission support and must expose the responder.");
  }
  return respond;
};

const isPending = async (promise: Promise<unknown>): Promise<boolean> =>
  (await Promise.race([promise.then(() => "settled"), Promise.resolve("pending")])) === "pending";

describe("fake agent harness script replay", () => {
  it("replays declared steps in order with a contract-valid monotonic sequence", async () => {
    const harness = createHarness([
      { kind: "emit", event: { type: "started" } },
      { kind: "emit", event: { type: "output", stream: "stdout", text: "reading the plan" } },
      { kind: "emit", event: { type: "completed", evidenceDigests: [digest("3")] } }
    ]);

    const events = await collect(harness.start(invocation));

    expect(events.map((event) => event.type)).toEqual(["started", "output", "completed"]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    for (const event of events) {
      expect(AgentSessionEventSchema.parse(event)).toEqual(event);
      expect(event.sessionId).toBe(invocation.agentSessionId);
    }
    const timestamps = events.map((event) => Date.parse(event.occurredAt));
    expect(timestamps).toEqual([...timestamps].sort((left, right) => left - right));
    expect(new Set(timestamps).size).toBe(timestamps.length);
    expect(events[0]).toMatchObject({ providerSessionRef: "fake.session.1" });
  });

  it("refuses to emit a step the contract rejects", async () => {
    const harness = createHarness([
      { kind: "emit", event: { type: "started" } },
      { kind: "emit", event: { type: "completed", evidenceDigests: [] } }
    ]);

    await expect(collect(harness.start(invocation))).rejects.toThrow();
  });

  it("blocks on a declared steer step until the consumer steers", async () => {
    const harness = createHarness([
      { kind: "emit", event: { type: "started" } },
      { kind: "await_steer", reason: "awaiting reviewer direction" },
      { kind: "emit", event: { type: "completed", evidenceDigests: [digest("3")] } }
    ]);

    const iterator = harness.start(invocation)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "started" });
    expect((await iterator.next()).value).toMatchObject({
      type: "waiting",
      reason: "awaiting reviewer direction"
    });

    const blocked = iterator.next();
    expect(await isPending(blocked)).toBe(true);
    expect(harness.sentMessages).toEqual([]);

    await harness.steer(steer);

    expect((await blocked).value).toMatchObject({ type: "completed" });
    expect(harness.sentMessages).toEqual([steer]);
  });
});

describe("fake agent harness capability honesty", () => {
  const script: FakeHarnessScript = [{ kind: "emit", event: { type: "started" } }];

  it("exposes a contract-valid descriptor built from the declared overrides", () => {
    const harness = createHarness(script, {
      adapterId: "fake.codex",
      kind: "codex",
      displayName: "Fake Codex",
      capabilities: { steering: false }
    });

    expect(AgentHarnessDescriptorSchema.parse(harness.descriptor)).toEqual(harness.descriptor);
    expect(harness.descriptor).toMatchObject({
      adapterId: "fake.codex",
      kind: "codex",
      displayName: "Fake Codex",
      capabilities: { resume: true, steering: false, permissions: true, structuredPlans: true }
    });
  });

  it("rejects steering that the descriptor does not declare", async () => {
    const harness = createHarness(script, { capabilities: { steering: false } });

    await expect(harness.steer(steer)).rejects.toThrow(/steering/i);
    expect(harness.sentMessages).toEqual([]);
  });

  it("rejects resumption that the descriptor does not declare", async () => {
    const harness = createHarness(script, { capabilities: { resume: false } });
    await collect(harness.start(invocation));

    await expect(collect(harness.resume(resumption))).rejects.toThrow(/resume/i);
  });

  it("rejects a cancellation envelope addressed to another session", async () => {
    const harness = createHarness([
      { kind: "emit", event: { type: "started" } },
      { kind: "await_steer", reason: "awaiting reviewer direction" }
    ]);
    const iterator = harness.start(invocation)[Symbol.asyncIterator]();
    await iterator.next();

    await expect(harness.cancel({ ...cancel, sessionId: foreignSessionId })).rejects.toThrow();
  });
});

describe("fake agent harness permission round trip", () => {
  const script: FakeHarnessScript = [
    { kind: "emit", event: { type: "started" } },
    {
      kind: "await_permission",
      permission: {
        permissionRef: "workspace.write",
        summary: "Write packages/domain/src/index.ts",
        evidenceDigest: digest("4"),
        options: [...permissionOptions]
      }
    },
    { kind: "emit", event: { type: "completed", evidenceDigests: [digest("3")] } }
  ];

  it("blocks on the request and admits only a response the request answers", async () => {
    const harness = createHarness(script);
    const iterator = harness.start(invocation)[Symbol.asyncIterator]();
    await iterator.next();

    expect((await iterator.next()).value).toMatchObject({
      type: "permission_requested",
      permissionRef: "workspace.write",
      evidenceDigest: digest("4")
    });

    const blocked = iterator.next();
    expect(await isPending(blocked)).toBe(true);
    expect(harness.pendingPermission).toMatchObject({
      permissionRef: "workspace.write",
      evidenceDigest: digest("4"),
      options: [...permissionOptions]
    });

    const respond = responderOf(harness);
    await expect(respond({ ...permissionResponse, selectedOptionId: "escalate" })).rejects.toThrow(
      /did not offer/
    );
    await expect(respond({ ...permissionResponse, evidenceDigest: digest("5") })).rejects.toThrow(
      /stale/
    );
    expect(harness.permissionResponses).toEqual([]);

    await respond(permissionResponse);

    expect((await blocked).value).toMatchObject({
      type: "permission_resolved",
      permissionRef: "workspace.write",
      selectedOptionId: "allow-once"
    });
    expect((await iterator.next()).value).toMatchObject({ type: "completed" });
    expect(harness.permissionResponses).toEqual([permissionResponse]);
    expect(harness.pendingPermission).toBeUndefined();
  });

  it("does not implement the responder port when the descriptor declares no permissions", () => {
    const harness = createHarness([{ kind: "emit", event: { type: "started" } }], {
      capabilities: { permissions: false }
    });

    expect(harness.respondToPermission).toBeUndefined();
    expect("respondToPermission" in harness).toBe(false);
  });

  it("refuses a permission step a harness without the capability could never answer", () => {
    expect(() => createHarness(script, { capabilities: { permissions: false } })).toThrow(
      /permission/i
    );
  });
});

describe("fake agent harness cancellation and disposal", () => {
  it("terminalizes a blocked stream with the contract cancellation event", async () => {
    const harness = createHarness([
      { kind: "emit", event: { type: "started" } },
      { kind: "await_steer", reason: "awaiting reviewer direction" },
      { kind: "emit", event: { type: "completed", evidenceDigests: [digest("3")] } }
    ]);
    const iterator = harness.start(invocation)[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    const blocked = iterator.next();

    await harness.cancel(cancel);

    const terminal = await blocked;
    expect(terminal.value).toMatchObject({ type: "cancelled", sequence: 3 });
    expect(AgentSessionEventSchema.parse(terminal.value)).toEqual(terminal.value);
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it("disposes idempotently and then refuses every port operation", async () => {
    const harness = createHarness([{ kind: "emit", event: { type: "started" } }]);
    await collect(harness.start(invocation));
    expect(harness.disposed).toBe(false);

    await expect(harness.dispose()).resolves.toBeUndefined();
    await expect(harness.dispose()).resolves.toBeUndefined();

    expect(harness.disposed).toBe(true);
    await expect(harness.steer(steer)).rejects.toThrow(/disposed/);
    await expect(harness.cancel(cancel)).rejects.toThrow(/disposed/);
    await expect(collect(harness.resume(resumption))).rejects.toThrow(/disposed/);
    await expect(responderOf(harness)(permissionResponse)).rejects.toThrow(/disposed/);
  });
});

describe("fake agent harness failure injection and resumption", () => {
  it("emits a declared retryable failure event and then throws a declared error", async () => {
    const injected = new Error("The provider transport reset the connection.");
    const harness = createHarness([
      { kind: "emit", event: { type: "started" } },
      {
        kind: "emit",
        event: {
          type: "failed",
          code: "provider.rate_limited",
          message: "The provider rejected the request.",
          retryable: true
        }
      },
      { kind: "throw", error: injected }
    ]);
    const iterator = harness.start(invocation)[Symbol.asyncIterator]();
    await iterator.next();

    expect((await iterator.next()).value).toMatchObject({
      type: "failed",
      code: "provider.rate_limited",
      retryable: true
    });
    await expect(iterator.next()).rejects.toBe(injected);
  });

  it("resumes the remaining script inside the same sequence space", async () => {
    const harness = createHarness([
      { kind: "emit", event: { type: "started" } },
      { kind: "emit", event: { type: "output", stream: "stdout", text: "reading the plan" } },
      { kind: "emit", event: { type: "completed", evidenceDigests: [digest("3")] } }
    ]);
    const iterator = harness.start(invocation)[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await iterator.return?.(undefined);

    const resumed = await collect(harness.resume(resumption));

    expect(resumed.map((event) => [event.type, event.sequence])).toEqual([["completed", 3]]);
  });
});

describe("fake agent harness detail events and view copies", () => {
  it("carries normalized detail events through the port", async () => {
    const harness = createHarness([
      { kind: "emit", event: { type: "started" } },
      {
        kind: "emit",
        event: { type: "plan", planDigest: digest("7"), summary: "Split the adapter." }
      },
      {
        kind: "emit",
        event: { type: "file_change", path: "packages/domain/src/index.ts", change: "modified" }
      },
      {
        kind: "emit",
        event: {
          type: "usage",
          tokens: {
            input: { state: "reported", value: 1_200 },
            output: { state: "reported", value: 340 },
            cachedInput: { state: "unknown" },
            reasoning: { state: "unknown" }
          },
          cost: { state: "unknown" }
        }
      },
      { kind: "emit", event: { type: "completed", evidenceDigests: [digest("3")] } }
    ]);

    const events = await collect(harness.start(invocation));

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "plan",
      "file_change",
      "usage",
      "completed"
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    for (const event of events) {
      expect(AgentSessionStreamEventSchema.parse(event)).toEqual(event);
    }
  });

  it("refuses a detail event the contract rejects", async () => {
    const harness = createHarness([
      { kind: "emit", event: { type: "started" } },
      {
        kind: "emit",
        event: { type: "file_change", path: "../outside/secrets.env", change: "modified" }
      }
    ]);

    await expect(collect(harness.start(invocation))).rejects.toThrow();
  });

  it("hands out copies so a consumer cannot mutate recorded state", async () => {
    const harness = createHarness([
      { kind: "emit", event: { type: "started" } },
      { kind: "await_steer", reason: "awaiting reviewer direction" }
    ]);
    const iterator = harness.start(invocation)[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await harness.steer(steer);

    const view = harness.sentMessages;
    view.slice().pop();
    expect(harness.sentMessages).toEqual([steer]);
    expect(harness.sentMessages).not.toBe(view);
    expect(harness.permissionResponses).not.toBe(harness.permissionResponses);
  });
});
