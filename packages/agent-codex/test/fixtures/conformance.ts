/**
 * Codex conformance fixture -- produces fresh subjects backed by the
 * fixture CLI replaying transcripts.
 *
 * Full capability subjects get:
 *   - resume: true
 *   - steering: true
 *   - permissions: true
 *
 * Minimal capability subjects get all three false.
 *
 * The existing Codex transcripts satisfy every conformance requirement:
 * - `codex-pauses`: the handshake consumes the objective via `thread/start`,
 *   and the `awaitStdin(turn/steer)` genuinely blocks.
 * - `codex-requests_permission`: places the approval request before any
 *   side-effect items (D-3 compliant ordering).
 * - Other scenarios map directly to their regular transcripts.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

import {
  AgentCancelRequestSchema,
  AgentInvocationRequestSchema,
  AgentPermissionResponseSchema,
  AgentResumeRequestSchema,
  AgentSteerRequestSchema,
  createId,
  type AgentPermissionRequest,
  type AgentSessionStreamEvent
} from "@autostack/contracts";
import { InMemoryEvidenceSink } from "@autostack/agent-adapter-kit";

import { CodexHarness } from "../../src/codex-harness.js";
import { CODEX_AUTH_VARIABLES } from "../../src/codex-launch-profile.js";
import type {
  AgentHarnessConformanceFixture,
  AgentHarnessConformanceScenario,
  AgentHarnessConformanceSubject,
  AgentHarnessMinimalScenario
} from "@autostack/domain/testing";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_AGENT = resolve(__dirname, "codex-agent.mjs");

const STEER_INSTRUCTION = "Prefer the smaller refactor.";
const DIGEST = "a".repeat(64);
const AGENT_CWD = mkdtempSync(resolve(tmpdir(), "codex-conformance-"));

const uuid = (value: number): string =>
  `123e4567-e89b-42d3-a456-${String(value).padStart(12, "0")}`;

const WORKSPACE_ID = createId("workspace", uuid(1));
const RUN_ID = createId("run", uuid(2));
const STAGE_RUN_ID = createId("stageRun", uuid(3));

let issuedSubjects = 0;

/**
 * Map a scenario to the transcript name the fixture CLI should replay.
 */
const fullTranscriptName = (scenario: AgentHarnessConformanceScenario): string => {
  switch (scenario) {
    case "completes":
      return "codex-completes";
    case "pauses":
      return "codex-pauses";
    case "requests_permission":
      return "codex-requests_permission";
    case "fails":
      return "codex-fails";
    case "interrupted":
      return "codex-interrupted";
  }
};

const providerSessionRefIn = (
  observed: readonly AgentSessionStreamEvent[]
): string | undefined => {
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

  const transcriptName = capabilities.full
    ? fullTranscriptName(scenario)
    : "codex-completes";

  const adapterId = capabilities.full
    ? "codex/app-server"
    : "codex/exec";

  const harness = CodexHarness.create({
    executable: process.execPath,
    args: [FIXTURE_AGENT, transcriptName],
    cwd: AGENT_CWD,
    evidenceSink: new InMemoryEvidenceSink(),
    descriptor: {
      schemaVersion: 1,
      adapterId,
      kind: "codex",
      displayName: capabilities.full ? "Codex (app-server)" : "Codex (exec)",
      capabilities: {
        resume: capabilities.full,
        steering: capabilities.full,
        permissions: capabilities.full,
        structuredPlans: false
      }
    },
    providerAuthVariables: [...CODEX_AUTH_VARIABLES],
    runtimeLimitMs: 10_000,
    progressTimeoutMs: 10_000,
    terminationGraceMs: 2_000
  });

  const agentSessionId = createId("agentSession", uuid(1_000 + subject));

  const invocation = AgentInvocationRequestSchema.parse({
    schemaVersion: 1,
    idempotencyKey: `conformance:${subject}:start`,
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    stageRunId: STAGE_RUN_ID,
    agentSessionId,
    adapterId,
    objective: "Implement the approved plan.",
    cwd: AGENT_CWD,
    inputEvidenceDigests: [DIGEST]
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
      evidenceDigest: DIGEST
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
        providerSessionRef:
          providerSessionRefIn(observed) ?? "01a04587-ce2e-7ca3-8e9e-ed05d8c37760",
        objective: "Continue the approved plan.",
        inputEvidenceDigests: [DIGEST]
      }),
    pendingPermission: async () => {
      return harness.pendingPermission;
    },
    permissionResponse: (
      request: AgentPermissionRequest,
      selectedOptionId: string
    ) => {
      decisions += 1;
      return AgentPermissionResponseSchema.parse({
        schemaVersion: 1,
        idempotencyKey: `conformance:${subject}:permission:${decisions}`,
        sessionId: request.sessionId,
        permissionRef: request.permissionRef,
        approvalId: createId(
          "approval",
          uuid(2_000 + decisions * 100 + subject)
        ),
        selectedOptionId,
        evidenceDigest: request.evidenceDigest,
        decidedAt: new Date().toISOString()
      });
    },
    quiesce: () => harness.quiesce(),
    dispose: () => harness.dispose()
  };
};

export const codexConformanceFixture: AgentHarnessConformanceFixture = {
  createFullCapabilityHarness: (scenario: AgentHarnessConformanceScenario) =>
    Promise.resolve(createSubject(scenario, { full: true })),
  createMinimalCapabilityHarness: (scenario: AgentHarnessMinimalScenario) =>
    Promise.resolve(createSubject(scenario, { full: false }))
};
