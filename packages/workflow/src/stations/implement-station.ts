/**
 * The `pipeline.implement` handler (spec §8.2, plan Task 9): provisions an environment using the
 * recorded authorization, starts a harness session against the approved plan, and commits the
 * implementation to the autostack-prefixed branch. Emits `ImplementationEvidence` binding the plan
 * approval, source commit, result commit, and diff digest.
 */

import {
  AgentInvocationRequestSchema,
  ArtifactIdSchema,
  EnvironmentAuthorizationSchema,
  PendingDomainEventSchema,
  type ArtifactId,
  type EnvironmentAuthorization,
  type PendingDomainEvent,
  type PreparedEnvironment,
  type StoredDomainEvent
} from "@autostack/contracts";
import { transitionRun, type LeasedWorkflowJob } from "@autostack/domain";
import { z } from "zod";

import type { WorkflowHandlerContext, WorkflowHandlerResult } from "../handler-registry.js";
import {
  executionBranchForRun,
  executionEnvironmentForRun,
  type ProjectExecutionConfiguration
} from "./execution-scope.js";
import { classifyStageFailure } from "./failure-taxonomy.js";
import type { PipelineJobPayload } from "./pipeline-job.js";
import type { StationDependencies } from "./station-context.js";
import { StageAbandoned, createStationKernel } from "./station-kernel.js";
import { readPipelineState } from "./station-kernel-state.js";

/**
 * What the station reads out of the harness's structured output: the commit pair and diff digest
 * produced by the implementation agent. Identity is added by the station, not the session (plan D13).
 */
const ImplementSessionResultSchema = z.object({
  resultCommit: z.string().regex(/^[0-9a-f]{40}$/i),
  finalDiffDigest: z.string().length(64),
  artifactIds: z.array(ArtifactIdSchema).default([])
});

type SessionOutcome =
  | { readonly kind: "result"; readonly value: unknown }
  | { readonly kind: "failed"; readonly event: unknown };

/**
 * Finds the environment authorization recorded on the run stream (plan Task 6 writes it).
 * Returns undefined when no authorization event exists yet.
 */
const findRecordedAuthorization = (
  events: readonly StoredDomainEvent[],
  runId: string
): EnvironmentAuthorization | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (
      event.type === "environment.authorization_recorded" &&
      event.stream.kind === "run" &&
      event.stream.id === runId
    ) {
      return EnvironmentAuthorizationSchema.parse(event.payload.authorization);
    }
  }
  return undefined;
};

/**
 * Finds the plan-approval evidence digest from the prior evidence chain.
 * The `plan_approval` stage evidence carries the `approvedEvidenceDigest` that the implement
 * evidence must bind to.
 */
const findPlanApprovalEvidenceDigest = (
  events: readonly StoredDomainEvent[],
  runId: string
): string | undefined => {
  for (const event of events) {
    if (
      event.type === "pipeline.evidence_recorded" &&
      event.stream.kind === "run" &&
      event.stream.id === runId &&
      event.payload.evidence?.stage === "plan_approval"
    ) {
      return event.payload.evidence.evidenceDigest as string;
    }
  }
  return undefined;
};

/**
 * Drives one implementation session to its end. The *last* structured output wins.
 */
const runSession = async (
  job: LeasedWorkflowJob,
  payload: PipelineJobPayload,
  environment: PreparedEnvironment,
  dependencies: StationDependencies,
  checkpoint: () => void
): Promise<SessionOutcome> => {
  const agentSessionId = dependencies.ids.agentSession();
  const invocation = AgentInvocationRequestSchema.parse({
    schemaVersion: 1,
    idempotencyKey: `implement:${job.jobId}:${job.attempt}`,
    workspaceId: job.workspaceId,
    runId: job.runId,
    workItemId: payload.workItemId,
    stageRunId: dependencies.ids.stageRun(),
    agentSessionId,
    environmentId: environment.environmentId,
    adapterId: dependencies.harness.descriptor.adapterId,
    objective: "Implement the approved plan on the provisioned branch.",
    cwd: ".",
    inputEvidenceDigests: payload.inputEvidenceDigests
  });

  let structured: unknown;
  for await (const event of dependencies.harness.start(invocation)) {
    checkpoint();
    if (event.type === "failed") return { kind: "failed", event };
    if (event.type === "output" && event.stream === "structured") {
      structured = JSON.parse(event.text) as unknown;
    }
  }
  return { kind: "result", value: structured };
};

/**
 * The `pipeline.implement` handler body: provisions the environment, runs the agent session,
 * reads the resulting commit, and emits implementation evidence.
 */
export const runImplementStation = async (
  payload: PipelineJobPayload,
  context: WorkflowHandlerContext,
  dependencies: StationDependencies,
  configuration: ProjectExecutionConfiguration
): Promise<WorkflowHandlerResult> => {
  const job = context.job;
  const kernel = createStationKernel(job, dependencies);
  const events = await dependencies.readRunEvents(job.runId);
  const state = readPipelineState(events, job.runId);
  const run = state.run;
  if (run === undefined) throw new TypeError("A run must be recorded before it can be implemented.");
  kernel.checkpoint();

  // Read the authorization recorded by the plan-approval decision (Task 6).
  const authorization = findRecordedAuthorization(events, job.runId);
  if (authorization === undefined) {
    throw new TypeError("An environment authorization must be recorded before implementation.");
  }

  // Find the plan-approval evidence digest to bind into the implementation evidence.
  const planApprovalEvidenceDigest = findPlanApprovalEvidenceDigest(events, job.runId);
  if (planApprovalEvidenceDigest === undefined) {
    throw new TypeError("A plan-approval evidence must be recorded before implementation.");
  }

  const environmentId = executionEnvironmentForRun(job.runId);
  const branch = executionBranchForRun(job.runId);
  const sourceCommit = authorization.scope.sourceCommit;

  // Provision the environment.
  let environment: PreparedEnvironment;
  try {
    environment = await dependencies.runner.prepareEnvironment({
      workspaceId: job.workspaceId,
      runId: job.runId,
      environmentId,
      inspection: {
        repositoryIdentity: authorization.scope.repositoryIdentity,
        canonicalSourcePath: configuration.inspection.sourcePath,
        repositoryCommonDirectory: `${configuration.inspection.sourcePath}/.git`,
        resolvedBaseRef: `refs/heads/${configuration.inspection.baseRef}`,
        sourceCommit,
        dirty: false,
        diagnostics: []
      },
      sourceCommit,
      branch,
      authorization,
      idempotency: { key: `implement:${job.jobId}:${job.attempt}` }
    });
  } catch (error) {
    if (error instanceof StageAbandoned) throw error;
    return kernel.failDeterministically(job, classifyStageFailure(error));
  }
  kernel.checkpoint();

  // Run the implementation session.
  let outcome: SessionOutcome;
  try {
    outcome = await runSession(job, payload, environment, dependencies, () => kernel.checkpoint());
  } catch (error) {
    if (error instanceof StageAbandoned) throw error;
    return kernel.failDeterministically(job, classifyStageFailure(error));
  }
  if (outcome.kind === "failed") {
    return kernel.failDeterministically(job, classifyStageFailure(outcome.event));
  }

  // Parse the structured output.
  let resultCommit: string;
  let finalDiffDigest: string;
  let artifactIds: readonly ArtifactId[];
  try {
    const result = ImplementSessionResultSchema.parse(outcome.value);
    resultCommit = result.resultCommit;
    finalDiffDigest = result.finalDiffDigest;
    artifactIds = result.artifactIds;
  } catch (error) {
    return kernel.failDeterministically(job, classifyStageFailure(error));
  }

  // Build implementation evidence.
  const agentSessionId = dependencies.ids.agentSession();
  const evidence = await kernel.buildEvidence({
    stage: "implement" as const,
    planApprovalEvidenceDigest,
    agentSessionId,
    environmentId,
    sourceCommit,
    resultCommit,
    finalDiffDigest,
    artifactIds
  });
  kernel.checkpoint();

  const occurredAt = dependencies.now();
  const correlationId = job.runId.slice(job.runId.indexOf("_") + 1);

  const recorded: PendingDomainEvent = PendingDomainEventSchema.parse({
    workspaceId: job.workspaceId,
    actor: dependencies.actor,
    correlationId,
    occurredAt,
    type: "pipeline.evidence_recorded",
    payload: {
      runId: job.runId,
      jobId: job.jobId,
      attempt: payload.attempt,
      evidence
    }
  });

  const transition = transitionRun({
    run,
    to: "verifying",
    reason: "Implementation committed, verification next.",
    actor: dependencies.actor,
    correlationId,
    occurredAt
  });

  // Validate the pipeline transition; the result is always "verify" from "implement".
  kernel.advance("implement", "verify", payload.attempt);
  const nextJobId = dependencies.ids.job();

  return {
    appends: [
      kernel.appendFor(state.streamVersion, [
        ...kernel.openStage(job),
        recorded,
        ...kernel.closeStage(job, { status: "succeeded" }),
        ...transition.events
      ])
    ],
    jobs: [
      {
        jobId: nextJobId,
        workspaceId: job.workspaceId,
        runId: job.runId,
        stage: "verify",
        handler: "pipeline.verify",
        payload: {
          workItemId: payload.workItemId,
          pipelineStage: "verify",
          attempt: 1,
          inputEvidenceDigests: [evidence.evidenceDigest]
        },
        maxAttempts: 3,
        availableAt: occurredAt,
        createdAt: occurredAt
      }
    ]
  };
};
