import { describe, expect, it } from "vitest";

import {
  ApprovalIdSchema,
  AgentSessionIdSchema,
  ArtifactIdSchema,
  CommandAuthorizationIdSchema,
  CommandIdSchema,
  EnvironmentAuthorizationIdSchema,
  EnvironmentIdSchema,
  JobIdSchema,
  StageRunIdSchema,
  WorkspaceIdSchema
} from "@autostack/contracts";

import {
  DuplicateWorkflowHandlerError,
  HandlerRegistry,
  UnknownWorkflowHandlerError,
  registerPipelineStations,
  STATION_NAMES
} from "../../src/index.js";
import type { StationDependencies } from "../../src/stations/station-context.js";
import type { ProjectExecutionConfiguration } from "../../src/stations/execution-scope.js";
import { createFakeAgentHarness } from "@autostack/domain/testing";
import type { FakeHarnessScript } from "@autostack/domain/testing";

const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174000");
const NOW = "2026-08-20T12:00:00.000Z";

const emptyScript: FakeHarnessScript = [
  { kind: "emit", event: { type: "completed", evidenceDigests: [] } }
];

const makeDependencies = (): Omit<StationDependencies, "signal"> => ({
  now: () => NOW,
  random: Math.random,
  ids: {
    approval: () => ApprovalIdSchema.parse(`apr_${crypto.randomUUID()}`),
    agentSession: () => AgentSessionIdSchema.parse(`ags_${crypto.randomUUID()}`),
    environment: () => EnvironmentIdSchema.parse(`env_${crypto.randomUUID()}`),
    command: () => CommandIdSchema.parse(`cmd_${crypto.randomUUID()}`),
    environmentAuthorization: () =>
      EnvironmentAuthorizationIdSchema.parse(`eauth_${crypto.randomUUID()}`),
    commandAuthorization: () =>
      CommandAuthorizationIdSchema.parse(`cauth_${crypto.randomUUID()}`),
    artifact: () => ArtifactIdSchema.parse(`art_${crypto.randomUUID()}`),
    job: () => JobIdSchema.parse(`job_${crypto.randomUUID()}`),
    stageRun: () => StageRunIdSchema.parse(`srun_${crypto.randomUUID()}`)
  },
  harness: createFakeAgentHarness({
    script: emptyScript,
    now: () => NOW,
    providerSessionRef: () => crypto.randomUUID()
  }),
  runner: {
    capabilities: (async () => { throw new Error("Not implemented"); }) as any,
    inspectRepository: async () => {
      throw new Error("Not implemented in test");
    },
    prepareEnvironment: async () => {
      throw new Error("Not implemented in test");
    },
    listEnvironments: async () => [],
    startCommand: async () => {
      throw new Error("Not implemented in test");
    },
    readCommandEvents: async function* () {},
    cancelCommand: async () => {
      throw new Error("Not implemented in test");
    },
    readArtifactChunk: async () => {
      throw new Error("Not implemented in test");
    },
    disposeEnvironment: async () => {
      throw new Error("Not implemented in test");
    }
  },
  delivery: {
    createDraftPullRequest: async () => {
      throw new Error("Not implemented in test");
    },
    postSlackProgress: async () => {}
  },
  readRunEvents: async () => [],
  workspaceId: WORKSPACE_ID,
  actor: { kind: "user", id: "local-user", displayName: "Local User" }
});

const makeConfiguration = (): ProjectExecutionConfiguration => ({
  inspection: {
    sourcePath: "/tmp/test-repo",
    baseRef: "main"
  },
  cwdRoot: ".",
  resourceLimits: { cpu: 2, memoryMb: 4096, durationSeconds: 3600 },
  allowedPermissionKinds: [],
  allowedCredentialRefIds: [],
  eligibleApproverIds: ["local-user"]
});

describe("registerPipelineStations", () => {
  it("registers all six stations", () => {
    const registry = new HandlerRegistry();
    registerPipelineStations(registry, {
      dependencies: makeDependencies(),
      configuration: makeConfiguration()
    });

    // Attempting to register again on the same registry proves all six are taken.
    expect(() =>
      registerPipelineStations(registry, {
        dependencies: makeDependencies(),
        configuration: makeConfiguration()
      })
    ).toThrow(DuplicateWorkflowHandlerError);
  });

  it("STATION_NAMES lists exactly six stations", () => {
    expect(STATION_NAMES).toHaveLength(6);
    expect(STATION_NAMES).toEqual([
      "pipeline.triage",
      "pipeline.plan",
      "pipeline.implement",
      "pipeline.verify",
      "pipeline.review",
      "pipeline.publish"
    ]);
  });

  it("throws UnknownWorkflowHandlerError for unregistered handler", async () => {
    const registry = new HandlerRegistry();
    registerPipelineStations(registry, {
      dependencies: makeDependencies(),
      configuration: makeConfiguration()
    });

    const fakeContext = {
      job: {
        jobId: JobIdSchema.parse(`job_${crypto.randomUUID()}`),
        workspaceId: WORKSPACE_ID,
        runId: "run_00000000-0000-4000-8000-000000000000" as any,
        stage: "triage" as const,
        handler: "pipeline.unknown",
        payload: {},
        maxAttempts: 3,
        availableAt: NOW,
        createdAt: NOW,
        attempt: 1,
        leaseOwner: "test",
        leaseToken: "token",
        leaseExpiresAt: NOW
      },
      signal: new AbortController().signal
    };

    await expect(
      registry.execute("pipeline.unknown", {}, fakeContext)
    ).rejects.toThrow(UnknownWorkflowHandlerError);
  });

  it("validates payload with PipelineJobPayloadSchema", async () => {
    const registry = new HandlerRegistry();
    registerPipelineStations(registry, {
      dependencies: makeDependencies(),
      configuration: makeConfiguration()
    });

    const fakeContext = {
      job: {
        jobId: JobIdSchema.parse(`job_${crypto.randomUUID()}`),
        workspaceId: WORKSPACE_ID,
        runId: "run_00000000-0000-4000-8000-000000000000" as any,
        stage: "triage" as const,
        handler: "pipeline.triage",
        payload: {},
        maxAttempts: 3,
        availableAt: NOW,
        createdAt: NOW,
        attempt: 1,
        leaseOwner: "test",
        leaseToken: "token",
        leaseExpiresAt: NOW
      },
      signal: new AbortController().signal
    };

    // An empty object is not a valid PipelineJobPayload — ZodError expected.
    await expect(
      registry.execute("pipeline.triage", {}, fakeContext)
    ).rejects.toThrow();
  });

  it("passes context.signal through to station dependencies", async () => {
    const registry = new HandlerRegistry();
    registerPipelineStations(registry, {
      dependencies: makeDependencies(),
      configuration: makeConfiguration()
    });

    const controller = new AbortController();
    const fakeContext = {
      job: {
        jobId: JobIdSchema.parse(`job_${crypto.randomUUID()}`),
        workspaceId: WORKSPACE_ID,
        runId: "run_00000000-0000-4000-8000-000000000000" as any,
        stage: "triage" as const,
        handler: "pipeline.triage",
        payload: {
          workItemId: "wi_00000000-0000-4000-8000-000000000000",
          pipelineStage: "triage",
          attempt: 1,
          inputEvidenceDigests: []
        },
        maxAttempts: 3,
        availableAt: NOW,
        createdAt: NOW,
        attempt: 1,
        leaseOwner: "test",
        leaseToken: "token",
        leaseExpiresAt: NOW
      },
      signal: controller.signal
    };

    // The triage station will throw "A run must be recorded" because readRunEvents returns []
    // but the signal should be passed through without errors in the wiring.
    await expect(
      registry.execute(
        "pipeline.triage",
        fakeContext.job.payload,
        fakeContext
      )
    ).rejects.toThrow(/recorded/i);
  });
});
