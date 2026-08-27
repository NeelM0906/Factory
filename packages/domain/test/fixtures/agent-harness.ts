import {
  AgentCancelRequestSchema,
  AgentInvocationRequestSchema,
  AgentPermissionResponseSchema,
  AgentResumeRequestSchema,
  AgentSteerRequestSchema,
  createId,
  type AgentPermissionOption,
  type AgentPermissionRequest,
  type AgentSessionStreamEvent
} from "@autostack/contracts";

import type {
  AgentHarnessConformanceFixture,
  AgentHarnessConformanceScenario,
  AgentHarnessConformanceSubject,
  AgentHarnessMinimalScenario
} from "../../src/testing/agent-harness-conformance-fixture.js";
import { createFakeAgentHarness } from "../../src/testing/fake-agent-harness.js";
import type { FakeHarnessScript } from "../../src/testing/fake-agent-harness-script.js";

const digest = (character: string): string => character.repeat(64);

const INPUT_DIGEST = digest("1");
const PLAN_DIGEST = digest("2");
const DIFF_DIGEST = digest("3");
const COMPLETION_DIGEST = digest("4");
const PERMISSION_DIGEST = digest("5");
const STEER_DIGEST = digest("6");
const PARTIAL_EVIDENCE_DIGEST = digest("7");

const STEER_INSTRUCTION = "Prefer the smaller refactor.";
const CHANGED_PATH = "packages/domain/src/index.ts";

const PERMISSION_OPTIONS: readonly AgentPermissionOption[] = [
  { optionId: "allow-once", kind: "allow_once", label: "Allow this write" },
  { optionId: "deny-once", kind: "deny_once", label: "Deny this write" }
];

/**
 * Every figure the fake's provider does not report stays unknown. The conformance suite reads this
 * as proof that absent usage has a representation other than zero.
 */
const USAGE_STEP = {
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
} as const satisfies FakeHarnessScript[number];

const STARTED_STEP = { kind: "emit", event: { type: "started" } } as const;

const FILE_CHANGE_STEP = {
  kind: "emit",
  event: { type: "file_change", path: CHANGED_PATH, change: "modified", diffDigest: DIFF_DIGEST }
} as const satisfies FakeHarnessScript[number];

const COMPLETED_STEP = {
  kind: "emit",
  event: { type: "completed", evidenceDigests: [COMPLETION_DIGEST] }
} as const satisfies FakeHarnessScript[number];

const PLAN_STEP = {
  kind: "emit",
  event: { type: "plan", planDigest: PLAN_DIGEST, summary: "Split the adapter from its transport." }
} as const satisfies FakeHarnessScript[number];

const completionScript = (structuredPlans: boolean): FakeHarnessScript => [
  STARTED_STEP,
  {
    kind: "emit",
    event: { type: "message", role: "assistant", text: "Reading the approved plan." }
  },
  ...(structuredPlans ? [PLAN_STEP] : []),
  {
    kind: "emit",
    event: { type: "tool_call", toolCallRef: "tool-1", name: "read_file", phase: "started" }
  },
  {
    kind: "emit",
    event: { type: "tool_call", toolCallRef: "tool-1", name: "read_file", phase: "completed" }
  },
  FILE_CHANGE_STEP,
  USAGE_STEP,
  COMPLETED_STEP
];

/** Blocks until the consumer steers or cancels, then echoes the instruction it was given. */
const PAUSE_SCRIPT: FakeHarnessScript = [
  STARTED_STEP,
  { kind: "await_steer", reason: "awaiting reviewer direction" },
  { kind: "emit", event: { type: "message", role: "user", text: STEER_INSTRUCTION } },
  COMPLETED_STEP
];

/** The file change is deliberately scripted after the decision, so gating is observable. */
const PERMISSION_SCRIPT: FakeHarnessScript = [
  STARTED_STEP,
  {
    kind: "await_permission",
    permission: {
      permissionRef: "workspace.write",
      summary: `Write ${CHANGED_PATH}`,
      evidenceDigest: PERMISSION_DIGEST,
      options: PERMISSION_OPTIONS
    }
  },
  FILE_CHANGE_STEP,
  COMPLETED_STEP
];

const FAILURE_SCRIPT: FakeHarnessScript = [
  STARTED_STEP,
  { kind: "emit", event: { type: "output", stream: "stderr", text: "provider returned HTTP 429" } },
  {
    kind: "emit",
    event: {
      type: "failed",
      code: "provider_rate_limited",
      message: "The provider rejected the request.",
      retryable: true
    }
  }
];

const INTERRUPTION_SCRIPT: FakeHarnessScript = [
  STARTED_STEP,
  FILE_CHANGE_STEP,
  {
    kind: "emit",
    event: {
      type: "interrupted",
      reason: "The agent host process exited before the session finished.",
      retryable: true,
      evidenceDigests: [PARTIAL_EVIDENCE_DIGEST]
    }
  }
];

const scriptFor = (
  scenario: AgentHarnessConformanceScenario,
  structuredPlans: boolean
): FakeHarnessScript => {
  switch (scenario) {
    case "completes":
      return completionScript(structuredPlans);
    case "pauses":
      return PAUSE_SCRIPT;
    case "requests_permission":
      return PERMISSION_SCRIPT;
    case "fails":
      return FAILURE_SCRIPT;
    case "interrupted":
      return INTERRUPTION_SCRIPT;
  }
};

const uuid = (value: number): string =>
  `123e4567-e89b-42d3-a456-${String(value).padStart(12, "0")}`;

const WORKSPACE_ID = createId("workspace", uuid(1));
const RUN_ID = createId("run", uuid(2));
const STAGE_RUN_ID = createId("stageRun", uuid(3));
const ENVIRONMENT_ID = createId("environment", uuid(4));

/** Distinct identities and timestamps per subject, so no behaviour can observe another's state. */
let issuedSubjects = 0;

const createClock = (subject: number): (() => string) => {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.UTC(2026, 7, 26, 12, subject % 60, tick % 60, tick)).toISOString();
  };
};

const providerSessionRefIn = (observed: readonly AgentSessionStreamEvent[]): string | undefined => {
  for (const event of observed) {
    if (event.type === "started" && event.providerSessionRef !== undefined) {
      return event.providerSessionRef;
    }
  }
  return undefined;
};

const createSubject = (
  scenario: AgentHarnessConformanceScenario,
  capabilities: { readonly full: boolean }
): AgentHarnessConformanceSubject => {
  issuedSubjects += 1;
  const subject = issuedSubjects;
  const now = createClock(subject);
  const providerSessionRef = `fake.session.${subject}`;
  const adapterId = capabilities.full ? "fake.agent-harness" : "fake.agent-harness.minimal";

  const harness = createFakeAgentHarness({
    script: scriptFor(scenario, capabilities.full),
    now,
    providerSessionRef: () => providerSessionRef,
    descriptor: capabilities.full
      ? { adapterId }
      : {
          adapterId,
          displayName: "Fake Minimal Agent Harness",
          capabilities: {
            resume: false,
            steering: false,
            permissions: false,
            structuredPlans: false
          }
        }
  });

  const agentSessionId = createId("agentSession", uuid(1_000 + subject));
  const invocation = AgentInvocationRequestSchema.parse({
    schemaVersion: 1,
    idempotencyKey: `conformance:${subject}:start`,
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    stageRunId: STAGE_RUN_ID,
    agentSessionId,
    environmentId: ENVIRONMENT_ID,
    adapterId,
    objective: "Implement the approved plan.",
    cwd: "/workspace/factory",
    inputEvidenceDigests: [INPUT_DIGEST]
  });

  let decisions = 0;

  return {
    harness,
    invocation,
    steer: AgentSteerRequestSchema.parse({
      schemaVersion: 1,
      idempotencyKey: `conformance:${subject}:steer`,
      sessionId: agentSessionId,
      instruction: STEER_INSTRUCTION,
      evidenceDigest: STEER_DIGEST
    }),
    cancel: AgentCancelRequestSchema.parse({
      schemaVersion: 1,
      idempotencyKey: `conformance:${subject}:cancel`,
      sessionId: agentSessionId,
      reason: "The operator withdrew the run."
    }),
    resumeRequest: (observed) =>
      AgentResumeRequestSchema.parse({
        schemaVersion: 1,
        idempotencyKey: `conformance:${subject}:resume`,
        sessionId: agentSessionId,
        providerSessionRef: providerSessionRefIn(observed) ?? providerSessionRef,
        objective: "Continue the approved plan.",
        inputEvidenceDigests: [INPUT_DIGEST]
      }),
    pendingPermission: async () => harness.pendingPermission,
    permissionResponse: (request: AgentPermissionRequest, selectedOptionId: string) => {
      decisions += 1;
      return AgentPermissionResponseSchema.parse({
        schemaVersion: 1,
        idempotencyKey: `conformance:${subject}:permission:${decisions}`,
        sessionId: request.sessionId,
        permissionRef: request.permissionRef,
        approvalId: createId("approval", uuid(2_000 + decisions * 100 + subject)),
        selectedOptionId,
        evidenceDigest: request.evidenceDigest,
        decidedAt: now()
      });
    },
    dispose: () => harness.dispose()
  };
};

export const agentHarnessConformanceFixture: AgentHarnessConformanceFixture = {
  createFullCapabilityHarness: (scenario: AgentHarnessConformanceScenario) =>
    Promise.resolve(createSubject(scenario, { full: true })),
  createMinimalCapabilityHarness: (scenario: AgentHarnessMinimalScenario) =>
    Promise.resolve(createSubject(scenario, { full: false }))
};
