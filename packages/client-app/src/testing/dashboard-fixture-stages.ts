import { emitStageTriple, type DashboardEventStream } from "./dashboard-fixture-support.js";
import {
  RUN_ACTIVE_IMPLEMENTING,
  RUN_ACTIVE_REVIEWING,
  RUN_AWAITING_PLAN_APPROVAL,
  RUN_COMPLETED_FAST,
  RUN_FAILED,
  RUN_NEEDS_CLARIFICATION,
  jobIds
} from "./dashboard-fixture-ids.js";

/**
 * The fixture's 19 stage lease/succeed/fail triples across all six stages, including the one
 * `implement` triple at `attempt: 3` (composition table). Every triple uses a uniform queued ->
 * leased gap of 5s and a leased -> terminal gap of 60s (succeeded) or 45s (failed), so latency
 * arithmetic stays hand-computable downstream.
 */
export function seedDashboardStages(stream: DashboardEventStream): void {
  emitStageTriple(stream, {
    runId: RUN_COMPLETED_FAST,
    stage: "triage",
    jobId: jobIds.completedFast.triage,
    workerId: "worker-1",
    attempt: 1,
    queuedAt: "2026-08-20T10:00:05.000Z",
    leasedAt: "2026-08-20T10:00:10.000Z",
    outcome: { kind: "succeeded", at: "2026-08-20T10:01:10.000Z" }
  });
  emitStageTriple(stream, {
    runId: RUN_COMPLETED_FAST,
    stage: "plan",
    jobId: jobIds.completedFast.plan,
    workerId: "worker-1",
    attempt: 1,
    queuedAt: "2026-08-20T10:01:15.000Z",
    leasedAt: "2026-08-20T10:01:20.000Z",
    outcome: { kind: "succeeded", at: "2026-08-20T10:02:20.000Z" }
  });
  emitStageTriple(stream, {
    runId: RUN_COMPLETED_FAST,
    stage: "implement",
    jobId: jobIds.completedFast.implement,
    workerId: "worker-1",
    attempt: 1,
    queuedAt: "2026-08-20T10:02:25.000Z",
    leasedAt: "2026-08-20T10:02:30.000Z",
    outcome: { kind: "succeeded", at: "2026-08-20T10:03:30.000Z" }
  });
  emitStageTriple(stream, {
    runId: RUN_COMPLETED_FAST,
    stage: "verify",
    jobId: jobIds.completedFast.verify,
    workerId: "worker-1",
    attempt: 1,
    queuedAt: "2026-08-20T10:03:35.000Z",
    leasedAt: "2026-08-20T10:03:40.000Z",
    outcome: { kind: "succeeded", at: "2026-08-20T10:04:40.000Z" }
  });
  emitStageTriple(stream, {
    runId: RUN_COMPLETED_FAST,
    stage: "review",
    jobId: jobIds.completedFast.review,
    workerId: "worker-1",
    attempt: 1,
    queuedAt: "2026-08-20T10:04:45.000Z",
    leasedAt: "2026-08-20T10:04:50.000Z",
    outcome: { kind: "succeeded", at: "2026-08-20T10:05:50.000Z" }
  });
  // The fixture's sole `publish` stage success (composition table: "1 publish stage success").
  emitStageTriple(stream, {
    runId: RUN_COMPLETED_FAST,
    stage: "publish",
    jobId: jobIds.completedFast.publish,
    workerId: "worker-1",
    attempt: 1,
    queuedAt: "2026-08-20T10:05:55.000Z",
    leasedAt: "2026-08-20T10:06:00.000Z",
    outcome: { kind: "succeeded", at: "2026-08-20T10:07:00.000Z" }
  });

  emitStageTriple(stream, {
    runId: RUN_FAILED,
    stage: "triage",
    jobId: jobIds.failed.triage,
    workerId: "worker-2",
    attempt: 1,
    queuedAt: "2026-08-20T09:00:05.000Z",
    leasedAt: "2026-08-20T09:00:10.000Z",
    outcome: { kind: "succeeded", at: "2026-08-20T09:01:10.000Z" }
  });
  emitStageTriple(stream, {
    runId: RUN_FAILED,
    stage: "plan",
    jobId: jobIds.failed.plan,
    workerId: "worker-2",
    attempt: 1,
    queuedAt: "2026-08-20T09:01:15.000Z",
    leasedAt: "2026-08-20T09:01:20.000Z",
    outcome: { kind: "succeeded", at: "2026-08-20T09:02:20.000Z" }
  });
  // The fixture's one `implement` triple at attempt 3 (composition table).
  emitStageTriple(stream, {
    runId: RUN_FAILED,
    stage: "implement",
    jobId: jobIds.failed.implement,
    workerId: "worker-2",
    attempt: 3,
    queuedAt: "2026-08-20T09:02:25.000Z",
    leasedAt: "2026-08-20T09:02:30.000Z",
    outcome: { kind: "succeeded", at: "2026-08-20T09:03:30.000Z" }
  });
  emitStageTriple(stream, {
    runId: RUN_FAILED,
    stage: "verify",
    jobId: jobIds.failed.verify,
    workerId: "worker-2",
    attempt: 1,
    queuedAt: "2026-08-20T09:03:35.000Z",
    leasedAt: "2026-08-20T09:03:40.000Z",
    outcome: {
      kind: "failed",
      at: "2026-08-20T09:04:25.000Z",
      error: {
        code: "verification_failed",
        name: "VerificationFailed",
        message: "Verification suite reported failing tests.",
        retryable: true
      }
    }
  });

  emitStageTriple(stream, {
    runId: RUN_ACTIVE_IMPLEMENTING,
    stage: "triage",
    jobId: jobIds.activeImplementing.triage,
    workerId: "worker-3",
    attempt: 1,
    queuedAt: "2026-08-20T09:10:05.000Z",
    leasedAt: "2026-08-20T09:10:10.000Z",
    outcome: { kind: "succeeded", at: "2026-08-20T09:11:10.000Z" }
  });
  emitStageTriple(stream, {
    runId: RUN_ACTIVE_IMPLEMENTING,
    stage: "plan",
    jobId: jobIds.activeImplementing.plan,
    workerId: "worker-3",
    attempt: 1,
    queuedAt: "2026-08-20T09:11:15.000Z",
    leasedAt: "2026-08-20T09:11:20.000Z",
    outcome: { kind: "succeeded", at: "2026-08-20T09:12:20.000Z" }
  });

  emitStageTriple(stream, {
    runId: RUN_ACTIVE_REVIEWING,
    stage: "triage",
    jobId: jobIds.activeReviewing.triage,
    workerId: "worker-4",
    attempt: 1,
    queuedAt: "2026-08-20T09:15:05.000Z",
    leasedAt: "2026-08-20T09:15:10.000Z",
    outcome: { kind: "succeeded", at: "2026-08-20T09:16:10.000Z" }
  });
  emitStageTriple(stream, {
    runId: RUN_ACTIVE_REVIEWING,
    stage: "plan",
    jobId: jobIds.activeReviewing.plan,
    workerId: "worker-4",
    attempt: 1,
    queuedAt: "2026-08-20T09:16:15.000Z",
    leasedAt: "2026-08-20T09:16:20.000Z",
    outcome: { kind: "succeeded", at: "2026-08-20T09:17:20.000Z" }
  });
  emitStageTriple(stream, {
    runId: RUN_ACTIVE_REVIEWING,
    stage: "implement",
    jobId: jobIds.activeReviewing.implement,
    workerId: "worker-4",
    attempt: 1,
    queuedAt: "2026-08-20T09:17:25.000Z",
    leasedAt: "2026-08-20T09:17:30.000Z",
    outcome: { kind: "succeeded", at: "2026-08-20T09:18:30.000Z" }
  });
  emitStageTriple(stream, {
    runId: RUN_ACTIVE_REVIEWING,
    stage: "verify",
    jobId: jobIds.activeReviewing.verify,
    workerId: "worker-4",
    attempt: 1,
    queuedAt: "2026-08-20T09:18:35.000Z",
    leasedAt: "2026-08-20T09:18:40.000Z",
    outcome: { kind: "succeeded", at: "2026-08-20T09:19:40.000Z" }
  });

  emitStageTriple(stream, {
    runId: RUN_AWAITING_PLAN_APPROVAL,
    stage: "triage",
    jobId: jobIds.awaitingPlanApproval.triage,
    workerId: "worker-5",
    attempt: 1,
    queuedAt: "2026-08-20T09:20:05.000Z",
    leasedAt: "2026-08-20T09:20:10.000Z",
    outcome: { kind: "succeeded", at: "2026-08-20T09:21:10.000Z" }
  });
  emitStageTriple(stream, {
    runId: RUN_AWAITING_PLAN_APPROVAL,
    stage: "plan",
    jobId: jobIds.awaitingPlanApproval.plan,
    workerId: "worker-5",
    attempt: 1,
    queuedAt: "2026-08-20T09:21:15.000Z",
    leasedAt: "2026-08-20T09:21:20.000Z",
    outcome: { kind: "succeeded", at: "2026-08-20T09:22:20.000Z" }
  });

  emitStageTriple(stream, {
    runId: RUN_NEEDS_CLARIFICATION,
    stage: "triage",
    jobId: jobIds.needsClarification.triage,
    workerId: "worker-6",
    attempt: 1,
    queuedAt: "2026-08-20T09:30:05.000Z",
    leasedAt: "2026-08-20T09:30:10.000Z",
    outcome: { kind: "succeeded", at: "2026-08-20T09:30:55.000Z" }
  });
}
