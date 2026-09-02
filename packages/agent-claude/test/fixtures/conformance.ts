/**
 * Claude Code conformance fixture -- produces fresh subjects backed by the
 * fixture CLI replaying conformance-specific transcripts.
 *
 * Full capability subjects get:
 *   - resume: true
 *   - steering: true
 *   - permissions: true
 *
 * Minimal capability subjects get all three false.
 *
 * Conformance transcripts differ from the regular test transcripts:
 * - `conformance-pauses`: prepends an awaitStdin so start()'s objective is
 *   consumed and the second awaitStdin genuinely blocks.
 * - `conformance-requests_permission`: places the assistant tool_use AFTER the
 *   permission decision so no tool_call event is emitted before permission_resolved
 *   (D-3 compliant ordering).
 * - Other scenarios reuse the regular transcripts.
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

import { ClaudeHarness } from "../../src/claude-harness.js";
import { CLAUDE_AUTH_VARIABLES } from "../../src/claude-launch-profile.js";
import type {
  AgentHarnessConformanceFixture,
  AgentHarnessConformanceScenario,
  AgentHarnessConformanceSubject,
  AgentHarnessMinimalScenario
} from "@autostack/domain/testing";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_AGENT = resolve(__dirname, "claude-agent.mjs");

const STEER_INSTRUCTION = "Prefer the smaller refactor.";
const DIGEST = "a".repeat(64);
const AGENT_CWD = mkdtempSync(resolve(tmpdir(), "claude-conformance-"));

const uuid = (value: number): string =>
  `123e4567-e89b-42d3-a456-${String(value).padStart(12, "0")}`;

const WORKSPACE_ID = createId("workspace", uuid(1));
const RUN_ID = createId("run", uuid(2));
const STAGE_RUN_ID = createId("stageRun", uuid(3));

let issuedSubjects = 0;

/**
 * Map a scenario to the transcript name the fixture CLI should replay.
 * Conformance-specific transcripts exist for pauses and requests_permission;
 * other scenarios reuse the regular test transcripts.
 */
const fullTranscriptName = (scenario: AgentHarnessConformanceScenario): string => {
  switch (scenario) {
    case "pauses":
      return "conformance-pauses";
    case "requests_permission":
      return "conformance-requests_permission";
    case "completes":
      return "claude-completes";
    case "fails":
      return "claude-fails";
    case "interrupted":
      return "claude-interrupted";
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

const PROVIDER_SESSION_ID = "11111111-2222-4333-8444-555555555555";

const createSubject = (
  scenario: AgentHarnessConformanceScenario,
  capabilities: { readonly full: boolean }
): AgentHarnessConformanceSubject => {
  issuedSubjects += 1;
  const subject = issuedSubjects;

  const transcriptName = capabilities.full
    ? fullTranscriptName(scenario)
    : "claude-completes";

  const resumeTranscriptName = "claude-completes";

  const adapterId = capabilities.full
    ? "claude-code/streaming"
    : "claude-code/batch";

  const harness = ClaudeHarness.create({
    executable: process.execPath,
    args: [FIXTURE_AGENT, transcriptName],
    cwd: AGENT_CWD,
    evidenceSink: new InMemoryEvidenceSink(),
    descriptor: {
      schemaVersion: 1,
      adapterId,
      kind: "claude",
      displayName: capabilities.full ? "Claude Code" : "Claude Code (batch)",
      capabilities: {
        resume: capabilities.full,
        steering: capabilities.full,
        permissions: capabilities.full,
        structuredPlans: false
      }
    },
    providerSessionId: PROVIDER_SESSION_ID,
    providerAuthVariables: CLAUDE_AUTH_VARIABLES,
    runtimeLimitMs: 10_000,
    progressTimeoutMs: 10_000,
    terminationGraceMs: 2_000,
    resumeArgs: [FIXTURE_AGENT, resumeTranscriptName]
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
          providerSessionRefIn(observed) ?? PROVIDER_SESSION_ID,
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

export const claudeConformanceFixture: AgentHarnessConformanceFixture = {
  createFullCapabilityHarness: (scenario: AgentHarnessConformanceScenario) =>
    Promise.resolve(createSubject(scenario, { full: true })),
  createMinimalCapabilityHarness: (scenario: AgentHarnessMinimalScenario) =>
    Promise.resolve(createSubject(scenario, { full: false }))
};
