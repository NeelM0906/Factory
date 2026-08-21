import { describe, expect, it } from "vitest";

import { EVENT_TYPES, PendingDomainEventSchema, StoredDomainEventSchema } from "../src/events.js";

const NOW = "2026-08-20T12:00:00.000Z";
const WORKSPACE_ID = "ws_123e4567-e89b-42d3-a456-426614174000";
const WORK_ITEM_ID = "wi_123e4567-e89b-42d3-a456-426614174000";
const RUN_ID = "run_123e4567-e89b-42d3-a456-426614174000";
const JOB_ID = "job_123e4567-e89b-42d3-a456-426614174000";
const APPROVAL_ID = "apr_123e4567-e89b-42d3-a456-426614174000";
const EVENT_ID = "evt_123e4567-e89b-42d3-a456-426614174000";
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174001";

const context = {
  workspaceId: WORKSPACE_ID,
  actor: { kind: "system", id: "autostack" },
  correlationId: CORRELATION_ID,
  occurredAt: NOW
} as const;

const workItem = {
  schemaVersion: 1,
  id: WORK_ITEM_ID,
  workspaceId: WORKSPACE_ID,
  source: { kind: "manual", client: "web" },
  title: "Create an event store",
  description: "",
  requester: { externalId: "local-user" },
  attachments: [],
  priority: "normal",
  labels: [],
  acceptanceContext: [],
  createdAt: NOW,
  updatedAt: NOW
} as const;

const run = {
  schemaVersion: 1,
  id: RUN_ID,
  workspaceId: WORKSPACE_ID,
  workItemId: WORK_ITEM_ID,
  workflowVersion: "foundation.v1",
  status: "queued",
  createdAt: NOW,
  updatedAt: NOW
} as const;

const approval = {
  schemaVersion: 1,
  id: APPROVAL_ID,
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  kind: "plan",
  status: "pending",
  evidenceDigest: "a".repeat(64),
  eligibleApproverIds: ["local-user"],
  createdAt: NOW,
  updatedAt: NOW
} as const;

const eventBodies = [
  { type: "work_item.created", payload: { workItem } },
  { type: "run.created", payload: { run } },
  {
    type: "run.transitioned",
    payload: { runId: RUN_ID, from: "queued", to: "triaging", reason: "work started" }
  },
  { type: "stage.queued", payload: { runId: RUN_ID, stage: "triage", jobId: JOB_ID } },
  {
    type: "stage.leased",
    payload: { runId: RUN_ID, stage: "triage", jobId: JOB_ID, workerId: "local-1", attempt: 1 }
  },
  { type: "stage.succeeded", payload: { runId: RUN_ID, stage: "triage", jobId: JOB_ID } },
  {
    type: "stage.failed",
    payload: {
      runId: RUN_ID,
      stage: "triage",
      jobId: JOB_ID,
      error: { name: "ProviderError", message: "temporarily unavailable", retryable: true }
    }
  },
  { type: "approval.requested", payload: { approval } },
  {
    type: "approval.decided",
    payload: {
      approvalId: APPROVAL_ID,
      runId: RUN_ID,
      decision: "approved",
      evidenceDigest: "a".repeat(64),
      origin: "desktop",
      decidedAt: NOW
    }
  }
] as const;

describe("domain event contracts", () => {
  it("covers every declared event type with a valid payload fixture", () => {
    const parsedTypes = eventBodies.map((body) =>
      PendingDomainEventSchema.parse({ ...context, ...body })
    );

    expect(parsedTypes.map(({ type }) => type)).toEqual(EVENT_TYPES);
  });

  it("rejects an unknown event type", () => {
    expect(() =>
      PendingDomainEventSchema.parse({
        ...context,
        type: "run.secretly_completed",
        payload: { runId: RUN_ID }
      })
    ).toThrow();
  });

  it("rejects a malformed event payload", () => {
    expect(() =>
      PendingDomainEventSchema.parse({
        ...context,
        type: "run.created",
        payload: { run: { ...run, id: "wrong" } }
      })
    ).toThrow();
  });

  it("requires store-assigned sequence metadata for stored events", () => {
    const pending = { ...context, ...eventBodies[1] };

    expect(() => StoredDomainEventSchema.parse(pending)).toThrow();
    expect(
      StoredDomainEventSchema.parse({
        ...pending,
        eventId: EVENT_ID,
        stream: { kind: "run", id: RUN_ID },
        streamVersion: 1,
        globalSequence: 1,
        schemaVersion: 1
      })
    ).toMatchObject({ eventId: EVENT_ID, globalSequence: 1, streamVersion: 1 });
  });

  it("rejects zero or fractional sequence values", () => {
    const stored = {
      ...context,
      ...eventBodies[1],
      eventId: EVENT_ID,
      stream: { kind: "run", id: RUN_ID },
      schemaVersion: 1
    };

    expect(() =>
      StoredDomainEventSchema.parse({ ...stored, streamVersion: 0, globalSequence: 1 })
    ).toThrow();
    expect(() =>
      StoredDomainEventSchema.parse({ ...stored, streamVersion: 1, globalSequence: 1.5 })
    ).toThrow();
  });
});
