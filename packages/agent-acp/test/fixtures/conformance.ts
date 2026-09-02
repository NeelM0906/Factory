/**
 * ACP conformance fixture — produces fresh subjects backed by the fixture
 * ACP agent that replays transcripts from disk.
 *
 * Full capability subjects get:
 *   - resume: true (loadSession: true in negotiation)
 *   - steering: true (ACP's session/prompt IS the steer)
 *   - permissions: true (permissionsConfigured: true)
 *
 * Minimal capability subjects get all three false.
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

import { AcpHarness } from "../../src/acp-harness.js";
import type {
  AgentHarnessConformanceFixture,
  AgentHarnessConformanceScenario,
  AgentHarnessConformanceSubject,
  AgentHarnessMinimalScenario
} from "@autostack/domain/testing";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_SCRIPT = resolve(__dirname, "acp-agent.mjs");
const TRANSCRIPTS_DIR = resolve(__dirname, "transcripts");

const STEER_INSTRUCTION = "Prefer the smaller refactor.";
const DIGEST = "a".repeat(64);
const AGENT_CWD = mkdtempSync(resolve(tmpdir(), "acp-conformance-"));

const uuid = (value: number): string =>
  `123e4567-e89b-42d3-a456-${String(value).padStart(12, "0")}`;

const WORKSPACE_ID = createId("workspace", uuid(1));
const RUN_ID = createId("run", uuid(2));
const STAGE_RUN_ID = createId("stageRun", uuid(3));

let issuedSubjects = 0;

const transcriptPath = (name: string): string =>
  resolve(TRANSCRIPTS_DIR, `${name}.json`);

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

/** Map a scenario to the conformance transcript filename (without extension). */
const fullTranscriptName = (scenario: AgentHarnessConformanceScenario): string =>
  `conformance-full-${scenario}`;

const createSubject = (
  scenario: AgentHarnessConformanceScenario,
  capabilities: { readonly full: boolean }
): AgentHarnessConformanceSubject => {
  issuedSubjects += 1;
  const subject = issuedSubjects;

  const transcriptFile = capabilities.full
    ? transcriptPath(fullTranscriptName(scenario))
    : transcriptPath("conformance-minimal-completes");

  const resumeTranscriptFile = transcriptPath("conformance-full-completes-resume");
  const adapterId = capabilities.full
    ? "acp/conformance-acp-agent/full"
    : "acp/conformance-acp-agent/minimal";

  const harness = AcpHarness.create({
    executable: process.execPath,
    args: [AGENT_SCRIPT, transcriptFile],
    cwd: AGENT_CWD,
    evidenceSink: new InMemoryEvidenceSink(),
    permissionsConfigured: capabilities.full,
    structuredPlans: false,
    resumeSupported: capabilities.full,
    steeringSupported: capabilities.full,
    runtimeLimitMs: 10_000,
    progressTimeoutMs: 5_000,
    terminationGraceMs: 2_000,
    resumeArgs: [AGENT_SCRIPT, resumeTranscriptFile]
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
          providerSessionRefIn(observed) ?? "sess_conf_full_completes",
        objective: "Continue the approved plan.",
        inputEvidenceDigests: [DIGEST]
      }),
    pendingPermission: async () => {
      // Poll for the pending permission to arrive via the harness.
      // The AcpHarness captures it from the session/request_permission frame.
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

export const acpConformanceFixture: AgentHarnessConformanceFixture = {
  createFullCapabilityHarness: (scenario: AgentHarnessConformanceScenario) =>
    Promise.resolve(createSubject(scenario, { full: true })),
  createMinimalCapabilityHarness: (scenario: AgentHarnessMinimalScenario) =>
    Promise.resolve(createSubject(scenario, { full: false }))
};
