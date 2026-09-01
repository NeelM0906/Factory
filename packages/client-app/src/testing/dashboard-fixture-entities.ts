import type { RunStatus } from "@autostack/contracts";

import type { DashboardEventStream } from "./dashboard-fixture-support.js";
import {
  RUN_ACTIVE_IMPLEMENTING,
  RUN_ACTIVE_REVIEWING,
  RUN_AWAITING_PLAN_APPROVAL,
  RUN_COMPLETED_FAST,
  RUN_COMPLETED_SLOW,
  RUN_FAILED,
  RUN_NEEDS_CLARIFICATION,
  WI_API_1,
  WI_GITHUB_1,
  WI_GITHUB_2,
  WI_GITHUB_3,
  WI_MANUAL_1,
  WI_SLACK_1,
  WI_SLACK_2,
  WORKSPACE_ID
} from "./dashboard-fixture-ids.js";

type WorkItemSource =
  | { readonly kind: "github"; readonly issueNumber: number; readonly deliveryId: string }
  | { readonly kind: "slack"; readonly channelId: string; readonly deliveryId: string }
  | { readonly kind: "manual" }
  | { readonly kind: "api"; readonly deliveryId: string };

function seedWorkItem(
  stream: DashboardEventStream,
  params: {
    readonly id: string;
    readonly source: WorkItemSource;
    readonly title: string;
    readonly requesterExternalId: string;
    readonly createdAt: string;
  }
): void {
  const source =
    params.source.kind === "github"
      ? {
          kind: "github" as const,
          repositoryFullName: "autostack/factory",
          issueNumber: params.source.issueNumber,
          deliveryId: params.source.deliveryId
        }
      : params.source.kind === "slack"
        ? {
            kind: "slack" as const,
            slackWorkspaceId: "T0DASH001",
            channelId: params.source.channelId,
            threadTs: "1700000100.000100",
            deliveryId: params.source.deliveryId
          }
        : params.source.kind === "manual"
          ? { kind: "manual" as const, client: "web" as const }
          : {
              kind: "api" as const,
              clientId: "fixture-api-client-1",
              deliveryId: params.source.deliveryId
            };

  stream.emit(
    {
      type: "work_item.created",
      payload: {
        workItem: {
          schemaVersion: 1,
          id: params.id,
          workspaceId: WORKSPACE_ID,
          source,
          title: params.title,
          description: "",
          requester: { externalId: params.requesterExternalId },
          attachments: [],
          priority: "normal",
          labels: [],
          acceptanceContext: [],
          createdAt: params.createdAt,
          updatedAt: params.createdAt
        }
      }
    },
    { kind: "work_item", id: params.id },
    params.createdAt
  );
}

/** The fixture's 7 work items: 3 github, 2 slack, 1 manual, 1 api (composition table). */
export function seedDashboardWorkItems(stream: DashboardEventStream): void {
  seedWorkItem(stream, {
    id: WI_GITHUB_1,
    source: { kind: "github", issueNumber: 101, deliveryId: "gh-delivery-101" },
    title: "Fix flaky retry in the publish stage",
    requesterExternalId: "octocat-1",
    createdAt: "2026-08-20T09:55:00.000Z"
  });
  seedWorkItem(stream, {
    id: WI_GITHUB_2,
    source: { kind: "github", issueNumber: 102, deliveryId: "gh-delivery-102" },
    title: "Investigate verify-stage timeout",
    requesterExternalId: "octocat-2",
    createdAt: "2026-08-20T08:55:00.000Z"
  });
  seedWorkItem(stream, {
    id: WI_GITHUB_3,
    source: { kind: "github", issueNumber: 103, deliveryId: "gh-delivery-103" },
    title: "Add pagination to the run list",
    requesterExternalId: "octocat-3",
    createdAt: "2026-08-20T09:05:00.000Z"
  });
  seedWorkItem(stream, {
    id: WI_SLACK_1,
    source: { kind: "slack", channelId: "C0DASH001", deliveryId: "slack-delivery-1" },
    title: "Customer reports slow dashboard load",
    requesterExternalId: "slack-user-1",
    createdAt: "2026-08-20T09:10:00.000Z"
  });
  seedWorkItem(stream, {
    id: WI_SLACK_2,
    source: { kind: "slack", channelId: "C0DASH002", deliveryId: "slack-delivery-2" },
    title: "Draft release notes for v1.4",
    requesterExternalId: "slack-user-2",
    createdAt: "2026-08-20T09:15:00.000Z"
  });
  seedWorkItem(stream, {
    id: WI_MANUAL_1,
    source: { kind: "manual" },
    title: "Rotate the staging seed data",
    requesterExternalId: "fixture-operator-1",
    createdAt: "2026-08-20T09:56:00.000Z"
  });
  seedWorkItem(stream, {
    id: WI_API_1,
    source: { kind: "api", deliveryId: "api-delivery-1" },
    title: "Automated dependency bump",
    requesterExternalId: "api-service-1",
    createdAt: "2026-08-20T09:25:00.000Z"
  });
}

function seedRunCreated(
  stream: DashboardEventStream,
  runId: string,
  workItemId: string,
  createdAt: string
): void {
  stream.emit(
    {
      type: "run.created",
      payload: {
        run: {
          schemaVersion: 1,
          id: runId,
          workspaceId: WORKSPACE_ID,
          workItemId,
          workflowVersion: "fixture-v1",
          status: "queued",
          createdAt,
          updatedAt: createdAt
        }
      }
    },
    { kind: "run", id: runId },
    createdAt
  );
}

function seedRunTransitioned(
  stream: DashboardEventStream,
  runId: string,
  from: RunStatus,
  to: RunStatus,
  occurredAt: string,
  reason: string
): void {
  stream.emit(
    { type: "run.transitioned", payload: { runId, from, to, reason } },
    { kind: "run", id: runId },
    occurredAt
  );
}

/**
 * The fixture's 7 runs and their 15 `run.transitioned` events, landing 2 active, 1 waiting on
 * approval, 1 blocked on clarification, 1 failed, 2 completed (composition table).
 */
export function seedDashboardRuns(stream: DashboardEventStream): void {
  // run_completed_fast: created 10:00:00Z -> completed 10:04:00Z (240s, the plan's own example).
  seedRunCreated(stream, RUN_COMPLETED_FAST, WI_GITHUB_1, "2026-08-20T10:00:00.000Z");
  seedRunTransitioned(
    stream,
    RUN_COMPLETED_FAST,
    "queued",
    "implementing",
    "2026-08-20T10:00:30.000Z",
    "Run entered execution."
  );
  seedRunTransitioned(
    stream,
    RUN_COMPLETED_FAST,
    "implementing",
    "completed",
    "2026-08-20T10:04:00.000Z",
    "Run completed successfully."
  );

  // run_completed_slow: created 10:01:00Z -> completed 10:11:00Z (600s, the plan's own example).
  seedRunCreated(stream, RUN_COMPLETED_SLOW, WI_MANUAL_1, "2026-08-20T10:01:00.000Z");
  seedRunTransitioned(
    stream,
    RUN_COMPLETED_SLOW,
    "queued",
    "implementing",
    "2026-08-20T10:02:00.000Z",
    "Run entered execution."
  );
  seedRunTransitioned(
    stream,
    RUN_COMPLETED_SLOW,
    "implementing",
    "completed",
    "2026-08-20T10:11:00.000Z",
    "Run completed successfully."
  );

  // run_failed: implement succeeds on its third attempt, then verify fails.
  seedRunCreated(stream, RUN_FAILED, WI_GITHUB_2, "2026-08-20T09:00:00.000Z");
  seedRunTransitioned(
    stream,
    RUN_FAILED,
    "queued",
    "implementing",
    "2026-08-20T09:05:00.000Z",
    "Run entered execution."
  );
  seedRunTransitioned(
    stream,
    RUN_FAILED,
    "implementing",
    "verifying",
    "2026-08-20T09:20:00.000Z",
    "Implementation succeeded on its third attempt."
  );
  seedRunTransitioned(
    stream,
    RUN_FAILED,
    "verifying",
    "failed",
    "2026-08-20T09:25:00.000Z",
    "Verification failed."
  );

  // run_active_implementing: still mid-stage, no terminal transition.
  seedRunCreated(stream, RUN_ACTIVE_IMPLEMENTING, WI_GITHUB_3, "2026-08-20T09:10:00.000Z");
  seedRunTransitioned(
    stream,
    RUN_ACTIVE_IMPLEMENTING,
    "queued",
    "implementing",
    "2026-08-20T09:12:00.000Z",
    "Run entered execution."
  );

  // run_active_reviewing: passes through waiting_for_user (a human intervention) before reviewing.
  seedRunCreated(stream, RUN_ACTIVE_REVIEWING, WI_SLACK_1, "2026-08-20T09:15:00.000Z");
  seedRunTransitioned(
    stream,
    RUN_ACTIVE_REVIEWING,
    "queued",
    "waiting_for_user",
    "2026-08-20T09:16:00.000Z",
    "Operator input requested before execution."
  );
  seedRunTransitioned(
    stream,
    RUN_ACTIVE_REVIEWING,
    "waiting_for_user",
    "implementing",
    "2026-08-20T09:18:00.000Z",
    "Operator input received."
  );
  seedRunTransitioned(
    stream,
    RUN_ACTIVE_REVIEWING,
    "implementing",
    "reviewing",
    "2026-08-20T09:40:00.000Z",
    "Implementation and verification succeeded."
  );

  // run_awaiting_plan_approval: paused for a plan approval that is still pending.
  seedRunCreated(stream, RUN_AWAITING_PLAN_APPROVAL, WI_SLACK_2, "2026-08-20T09:20:00.000Z");
  seedRunTransitioned(
    stream,
    RUN_AWAITING_PLAN_APPROVAL,
    "queued",
    "planning",
    "2026-08-20T09:21:00.000Z",
    "Run entered planning."
  );
  seedRunTransitioned(
    stream,
    RUN_AWAITING_PLAN_APPROVAL,
    "planning",
    "awaiting_plan_approval",
    "2026-08-20T09:25:00.000Z",
    "Plan submitted for approval."
  );

  // run_needs_clarification: blocked immediately after triage.
  seedRunCreated(stream, RUN_NEEDS_CLARIFICATION, WI_API_1, "2026-08-20T09:30:00.000Z");
  seedRunTransitioned(
    stream,
    RUN_NEEDS_CLARIFICATION,
    "queued",
    "triaging",
    "2026-08-20T09:30:30.000Z",
    "Run entered triage."
  );
  seedRunTransitioned(
    stream,
    RUN_NEEDS_CLARIFICATION,
    "triaging",
    "needs_clarification",
    "2026-08-20T09:31:00.000Z",
    "Triage needs clarification from the requester."
  );
}
