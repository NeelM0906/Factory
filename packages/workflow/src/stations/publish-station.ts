/**
 * The `pipeline.publish` handler (spec §8.2, plan Task 13): creates an idempotent draft pull
 * request via the delivery integration, emits draft-PR evidence, and transitions to `completed`.
 *
 * The station assembles a `PublicationEvidenceBundle` from all evidence recorded on the run stream,
 * passes it to `delivery.createDraftPullRequest` with `idempotencyKey = digestPublishScope(scope)`
 * (D6), and never merges or deploys.
 */

import {
  PendingDomainEventSchema,
  PublicationEvidenceBundleSchema,
  PublishScopeSchema,
  digestPublishScope,
  type PendingDomainEvent,
  type PipelineEvidence,
  type StoredDomainEvent
} from "@autostack/contracts";
import { transitionRun } from "@autostack/domain";

import type { WorkflowHandlerContext, WorkflowHandlerResult } from "../handler-registry.js";
import { executionBranchForRun, type ProjectExecutionConfiguration } from "./execution-scope.js";
import { classifyStageFailure } from "./failure-taxonomy.js";
import type { PipelineJobPayload } from "./pipeline-job.js";
import type { StationDependencies } from "./station-context.js";
import { StageAbandoned, createStationKernel } from "./station-kernel.js";
import { readPipelineState } from "./station-kernel-state.js";

// ---------------------------------------------------------------------------
// Event readers
// ---------------------------------------------------------------------------

const findEvidenceByStage = (
  events: readonly StoredDomainEvent[],
  runId: string,
  stage: string
): PipelineEvidence | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (
      event.type === "pipeline.evidence_recorded" &&
      event.stream.kind === "run" &&
      event.stream.id === runId &&
      event.payload.evidence?.stage === stage
    ) {
      return event.payload.evidence as PipelineEvidence;
    }
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Station entry point
// ---------------------------------------------------------------------------

export const runPublishStation = async (
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
  if (run === undefined) throw new TypeError("A run must be recorded before it can publish.");
  kernel.checkpoint();

  // Collect every evidence type from the run stream.
  const planEvidence = findEvidenceByStage(events, job.runId, "plan");
  if (planEvidence === undefined) throw new TypeError("Plan evidence must exist before publish.");

  const planApprovalEvidence = findEvidenceByStage(events, job.runId, "plan_approval");
  if (planApprovalEvidence === undefined) {
    throw new TypeError("Plan approval evidence must exist before publish.");
  }

  const implementationEvidence = findEvidenceByStage(events, job.runId, "implement");
  if (implementationEvidence === undefined) {
    throw new TypeError("Implementation evidence must exist before publish.");
  }

  const verificationEvidence = findEvidenceByStage(events, job.runId, "verify");
  if (verificationEvidence === undefined) {
    throw new TypeError("Verification evidence must exist before publish.");
  }

  const reviewEvidence = findEvidenceByStage(events, job.runId, "isolated_review");
  if (reviewEvidence === undefined) {
    throw new TypeError("Review evidence must exist before publish.");
  }

  const publishApprovalEvidence = findEvidenceByStage(events, job.runId, "publish_approval");
  if (publishApprovalEvidence === undefined) {
    throw new TypeError("Publish approval evidence must exist before publish.");
  }
  kernel.checkpoint();

  // The configuration must name the GitHub repository for the draft PR.
  if (configuration.repositoryFullName === undefined) {
    throw new TypeError(
      "The project configuration must include repositoryFullName for the publish station."
    );
  }

  // Reconstruct the publish scope from the evidence chain and configuration.
  const finalDiffDigest = (implementationEvidence as Record<string, unknown>)
    .finalDiffDigest as string;
  const publishScopeDraft = {
    schemaVersion: 1 as const,
    workspaceId: job.workspaceId,
    workItemId: payload.workItemId,
    runId: job.runId,
    repositoryFullName: configuration.repositoryFullName,
    base: configuration.inspection.baseRef,
    head: executionBranchForRun(job.runId),
    finalDiffDigest,
    action: "create_draft_pr" as const,
    scopeDigest: "0".repeat(64),
    createdAt: (publishApprovalEvidence as Record<string, unknown>).producedAt as string
  };
  const scopeDigest = await digestPublishScope(publishScopeDraft);
  const publishScope = PublishScopeSchema.parse({ ...publishScopeDraft, scopeDigest });
  kernel.checkpoint();

  // Assemble the publication evidence bundle.
  const bundle = PublicationEvidenceBundleSchema.parse({
    schemaVersion: 1,
    workspaceId: job.workspaceId,
    workItemId: payload.workItemId,
    runId: job.runId,
    plan: planEvidence,
    planApproval: planApprovalEvidence,
    implementation: implementationEvidence,
    verification: verificationEvidence,
    review: reviewEvidence,
    publishScope,
    publishApproval: publishApprovalEvidence
  });
  kernel.checkpoint();

  // D6: idempotency key is the publish scope digest.
  const idempotencyKey = scopeDigest;

  // Create the draft PR via the delivery integration.
  let draftPrResult;
  try {
    draftPrResult = await dependencies.delivery.createDraftPullRequest({
      schemaVersion: 1,
      idempotencyKey,
      repositoryFullName: publishScope.repositoryFullName,
      head: publishScope.head,
      base: publishScope.base,
      title: `[AutoStack] ${payload.workItemId}`,
      body: `AutoStack run ${job.runId}`,
      draft: true,
      finalDiffDigest: publishScope.finalDiffDigest,
      publicationEvidence: bundle
    });
  } catch (error) {
    if (error instanceof StageAbandoned) throw error;
    return kernel.failDeterministically(job, classifyStageFailure(error));
  }
  kernel.checkpoint();

  // Build draft-PR evidence.
  const evidence = await kernel.buildEvidence({
    stage: "draft_pr" as const,
    pullRequestUrl: draftPrResult.url,
    pullRequestNumber: draftPrResult.number,
    draft: true as const,
    reviewEvidenceDigest: reviewEvidence.evidenceDigest,
    publishApprovalEvidenceDigest: publishApprovalEvidence.evidenceDigest,
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
      evidence
    }
  });

  // Transition to completed — no follow-up jobs.
  const transition = transitionRun({
    run,
    to: "completed",
    reason: "Draft pull request created.",
    actor: dependencies.actor,
    correlationId,
    occurredAt
  });

  return {
    appends: [
      kernel.appendFor(state.streamVersion, [
        ...kernel.openStage(job),
        recorded,
        ...kernel.closeStage(job, { status: "succeeded" }),
        ...transition.events
      ])
    ],
    jobs: []
  };
};
