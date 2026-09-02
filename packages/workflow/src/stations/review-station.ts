/**
 * The `pipeline.review` handler (spec §8.2, plan Task 12): runs an isolated review harness session
 * in a separate environment, produces a ReviewReport, and emits ReviewEvidence. An approved review
 * advances to publish approval; changes_requested reworks to implement within the bounded attempt
 * budget.
 */

import { createHash } from "node:crypto";

import {
  AgentInvocationRequestSchema,
  AgentSessionIdSchema,
  EnvironmentAuthorizationSchema,
  EnvironmentIdSchema,
  PendingDomainEventSchema,
  ReviewReportSchema,
  digestReviewReport,
  type EnvironmentAuthorization,
  type EnvironmentId,
  type PendingDomainEvent,
  type PipelineEvidence,
  type PlanDocument,
  type PreparedEnvironment,
  type ReviewReport,
  type RunId,
  type StoredDomainEvent
} from "@autostack/contracts";
import { transitionRun, type LeasedWorkflowJob } from "@autostack/domain";

import type { WorkflowHandlerContext, WorkflowHandlerResult } from "../handler-registry.js";
import {
  executionBranchForRun,
  executionEnvironmentForRun,
  type ProjectExecutionConfiguration
} from "./execution-scope.js";
import { classifyStageFailure } from "./failure-taxonomy.js";
import type { PipelineJobPayload } from "./pipeline-job.js";
import { runRelayedSession } from "./session-relay.js";
import type { StationDependencies } from "./station-context.js";
import { StageAbandoned, createStationKernel } from "./station-kernel.js";
import { readPipelineState } from "./station-kernel-state.js";

// ---------------------------------------------------------------------------
// Review environment derivation
// ---------------------------------------------------------------------------

/**
 * Derives an environment ID for the review that differs from the implementer's. Uses a different
 * domain string so the SHA-256 produces a distinct UUID.
 */
const reviewEnvironmentForRun = (runId: RunId): EnvironmentId => {
  const characters = createHash("sha256")
    .update(`autostack.run-review-environment:${runId}`, "utf8")
    .digest("hex")
    .slice(0, 32)
    .split("");
  characters[12] = "4";
  characters[16] = "8";
  const value = characters.join("");
  return EnvironmentIdSchema.parse(
    `env_${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
  );
};

// ---------------------------------------------------------------------------
// Event readers
// ---------------------------------------------------------------------------

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

const findPlanDocument = (
  events: readonly StoredDomainEvent[],
  runId: string
): PlanDocument | undefined => {
  for (const event of events) {
    if (
      event.type === "pipeline.evidence_recorded" &&
      event.stream.kind === "run" &&
      event.stream.id === runId &&
      event.payload.document?.kind === "plan"
    ) {
      return event.payload.document.document as PlanDocument;
    }
  }
  return undefined;
};

const findEvidenceDigestByStage = (
  events: readonly StoredDomainEvent[],
  runId: string,
  stage: string
): string | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (
      event.type === "pipeline.evidence_recorded" &&
      event.stream.kind === "run" &&
      event.stream.id === runId &&
      event.payload.evidence?.stage === stage
    ) {
      return event.payload.evidence.evidenceDigest as string;
    }
  }
  return undefined;
};

const findImplementationEvidence = (
  events: readonly StoredDomainEvent[],
  runId: string
): PipelineEvidence | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (
      event.type === "pipeline.evidence_recorded" &&
      event.stream.kind === "run" &&
      event.stream.id === runId &&
      event.payload.evidence?.stage === "implement"
    ) {
      return event.payload.evidence as PipelineEvidence;
    }
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Station entry point
// ---------------------------------------------------------------------------

export const runReviewStation = async (
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
  if (run === undefined) throw new TypeError("A run must be recorded before it can be reviewed.");
  kernel.checkpoint();

  // Read prerequisites from the event stream.
  const planDocument = findPlanDocument(events, job.runId);
  if (planDocument === undefined) {
    throw new TypeError("A plan document must be recorded before review.");
  }

  const authorization = findRecordedAuthorization(events, job.runId);
  if (authorization === undefined) {
    throw new TypeError("An environment authorization must be recorded before review.");
  }

  const implementationEvidence = findImplementationEvidence(events, job.runId);
  if (implementationEvidence === undefined) {
    throw new TypeError("An implementation evidence must be recorded before review.");
  }

  const implementationEvidenceDigest = findEvidenceDigestByStage(events, job.runId, "implement");
  if (implementationEvidenceDigest === undefined) {
    throw new TypeError("An implementation evidence must be recorded before review.");
  }

  const verificationEvidenceDigest = findEvidenceDigestByStage(events, job.runId, "verify");
  if (verificationEvidenceDigest === undefined) {
    throw new TypeError("A verification evidence must be recorded before review.");
  }
  kernel.checkpoint();

  // The implementer's identity — the review evidence must name a different session and environment.
  const implementerSessionId = AgentSessionIdSchema.parse(
    (implementationEvidence as Record<string, unknown>).agentSessionId
  );
  const implementerEnvironmentId = executionEnvironmentForRun(job.runId);

  // The reviewer uses a different environment derived from a different domain.
  const reviewerEnvironmentId = reviewEnvironmentForRun(job.runId);
  const reviewerSessionId = dependencies.ids.agentSession();
  const branch = executionBranchForRun(job.runId);
  const sourceCommit = authorization.scope.sourceCommit;

  // Provision the review environment (separate from the implementer's).
  let environment: PreparedEnvironment;
  try {
    environment = await dependencies.runner.prepareEnvironment({
      workspaceId: job.workspaceId,
      runId: job.runId,
      environmentId: reviewerEnvironmentId,
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
      idempotency: { key: `review:${job.jobId}:${job.attempt}` }
    });
  } catch (error) {
    if (error instanceof StageAbandoned) throw error;
    return kernel.failDeterministically(job, classifyStageFailure(error));
  }
  kernel.checkpoint();

  // Run the review session via the harness.
  const stageRunId = dependencies.ids.stageRun();
  const invocation = AgentInvocationRequestSchema.parse({
    schemaVersion: 1,
    idempotencyKey: `review:${job.jobId}:${job.attempt}`,
    workspaceId: job.workspaceId,
    runId: job.runId,
    stageRunId,
    agentSessionId: reviewerSessionId,
    adapterId: "fake.agent-harness",
    objective: "Review the implementation against the approved plan.",
    cwd: configuration.cwdRoot,
    inputEvidenceDigests: payload.inputEvidenceDigests
  });

  const relay = await runRelayedSession(dependencies.harness, invocation, {
    workspaceId: job.workspaceId,
    runId: job.runId,
    stage: "review",
    agentSessionId: reviewerSessionId,
    actor: dependencies.actor,
    correlationId: job.runId.slice(job.runId.indexOf("_") + 1),
    now: dependencies.now,
    checkpoint: () => kernel.checkpoint()
  });

  if (relay.kind === "failed") {
    return kernel.failDeterministically(job, classifyStageFailure(relay.failure));
  }

  // Parse the review report from structured output.
  let report: ReviewReport;
  try {
    report = ReviewReportSchema.parse(relay.structured);
  } catch (error) {
    return kernel.failDeterministically(job, classifyStageFailure(error));
  }

  const reviewReportDigest = await digestReviewReport(report);
  const finalDiffDigest = (implementationEvidence as Record<string, unknown>)
    .finalDiffDigest as string;

  // Build review evidence.
  const evidence = await kernel.buildEvidence({
    stage: "isolated_review" as const,
    implementationEvidenceDigest,
    verificationEvidenceDigest,
    reviewedDiffDigest: finalDiffDigest,
    implementation: {
      agentSessionId: implementerSessionId,
      environmentId: implementerEnvironmentId
    },
    reviewer: {
      agentSessionId: reviewerSessionId,
      environmentId: reviewerEnvironmentId
    },
    reviewReportDigest,
    verdict: report.verdict,
    findings: report.findings.map((finding) => ({
      severity: finding.severity,
      summary: finding.summary,
      evidenceDigest: finding.evidenceDigest
    })),
    artifactIds: []
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
      evidence,
      document: { kind: "isolated_review", report }
    }
  });

  if (report.verdict === "changes_requested") {
    // Rework: route back to implement if attempts remain.
    try {
      kernel.advance("isolated_review", "implement", payload.attempt);
    } catch {
      return kernel.failDeterministically(job, {
        code: "rework_attempts_exhausted",
        name: "ReworkAttemptsExhausted",
        message: "Review requested changes and rework attempts are exhausted.",
        retryable: false
      });
    }

    const transition = transitionRun({
      run,
      to: "implementing",
      reason: "Review requested changes, reworking implementation.",
      actor: dependencies.actor,
      correlationId,
      occurredAt
    });

    const nextJobId = dependencies.ids.job();
    return {
      appends: [
        kernel.appendFor(state.streamVersion, [
          ...kernel.openStage(job),
          recorded,
          ...relay.events,
          ...kernel.closeStage(job, {
            status: "failed",
            error: {
              code: "review_changes_requested",
              name: "ReviewChangesRequested",
              message: "Reviewer requested changes to the implementation.",
              retryable: false
            }
          }),
          ...transition.events
        ])
      ],
      jobs: [
        {
          jobId: nextJobId,
          workspaceId: job.workspaceId,
          runId: job.runId,
          stage: "implement",
          handler: "pipeline.implement",
          payload: {
            workItemId: payload.workItemId,
            pipelineStage: "implement",
            attempt: payload.attempt + 1,
            inputEvidenceDigests: [evidence.evidenceDigest]
          },
          maxAttempts: 3,
          availableAt: occurredAt,
          createdAt: occurredAt
        }
      ]
    };
  }

  // Approved: transition to awaiting_publish_approval and enqueue nothing (D2).
  const transition = transitionRun({
    run,
    to: "awaiting_publish_approval",
    reason: "Review approved, publish approval next.",
    actor: dependencies.actor,
    correlationId,
    occurredAt
  });

  return {
    appends: [
      kernel.appendFor(state.streamVersion, [
        ...kernel.openStage(job),
        recorded,
        ...relay.events,
        ...kernel.closeStage(job, { status: "succeeded" }),
        ...transition.events
      ])
    ],
    jobs: []
  };
};
