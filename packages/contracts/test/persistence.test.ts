import { describe, expect, it } from "vitest";

import {
  CommitRequestSchema,
  PendingDomainEventSchema,
  StoredDomainEventSchema,
  StreamAppendSchema,
  WorkflowHandlerResultSchema
} from "../src/index.js";

const NOW = "2026-08-20T12:00:00.000Z";
const WORKSPACE_ID = "ws_123e4567-e89b-42d3-a456-426614174000";
const WORK_ITEM_ID = "wi_123e4567-e89b-42d3-a456-426614174000";
const RUN_ID = "run_123e4567-e89b-42d3-a456-426614174000";
const context = {
  workspaceId: WORKSPACE_ID,
  actor: { kind: "system", id: "autostack" },
  correlationId: "123e4567-e89b-42d3-a456-426614174001",
  occurredAt: NOW
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
const workItem = {
  schemaVersion: 1,
  id: WORK_ITEM_ID,
  workspaceId: WORKSPACE_ID,
  source: { kind: "manual", client: "api" },
  title: "Validate persistence",
  description: "",
  requester: { externalId: "local-user" },
  attachments: [],
  priority: "normal",
  labels: [],
  acceptanceContext: [],
  createdAt: NOW,
  updatedAt: NOW
} as const;

const append = (event: unknown, kind: "work_item" | "run", id: string) => ({
  stream: { kind, id },
  expectedVersion: 0,
  events: [PendingDomainEventSchema.parse(event)]
});

describe("persistence contracts", () => {
  it("validates a complete commit with typed stream and job identities", () => {
    const request = CommitRequestSchema.parse({
      idempotency: { scope: "test:commit", key: "request-1" },
      appends: [append({ ...context, type: "run.created", payload: { run } }, "run", RUN_ID)],
      jobs: [
        {
          jobId: "job_123e4567-e89b-42d3-a456-426614174000",
          workspaceId: WORKSPACE_ID,
          runId: RUN_ID,
          stage: "triage",
          handler: "foundation.triage",
          payload: { task: "triage", retries: 0 },
          maxAttempts: 3,
          availableAt: NOW,
          createdAt: NOW
        }
      ]
    });

    expect(request.jobs[0]).toMatchObject({ stage: "triage", handler: "foundation.triage" });
    expect(WorkflowHandlerResultSchema.parse({ appends: request.appends, jobs: [] })).toMatchObject(
      {
        jobs: []
      }
    );
  });

  it("enforces work-item, run, approval, and transition stream identities", () => {
    const approval = {
      schemaVersion: 1,
      id: "apr_123e4567-e89b-42d3-a456-426614174000",
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      kind: "plan",
      status: "pending",
      evidenceDigest: "a".repeat(64),
      eligibleApproverIds: ["local-user"],
      createdAt: NOW,
      updatedAt: NOW
    } as const;
    const fixtures = [
      append(
        { ...context, type: "work_item.created", payload: { workItem } },
        "work_item",
        WORK_ITEM_ID
      ),
      append({ ...context, type: "run.created", payload: { run } }, "run", RUN_ID),
      append({ ...context, type: "approval.requested", payload: { approval } }, "run", RUN_ID),
      append(
        {
          ...context,
          type: "run.transitioned",
          payload: { runId: RUN_ID, from: "queued", to: "triaging", reason: "started" }
        },
        "run",
        RUN_ID
      )
    ];

    for (const fixture of fixtures) expect(StreamAppendSchema.parse(fixture)).toBeDefined();
    expect(() =>
      StreamAppendSchema.parse({ ...fixtures[0], stream: { kind: "run", id: RUN_ID } })
    ).toThrow();
    expect(() =>
      StreamAppendSchema.parse({
        ...fixtures[1],
        events: [
          { ...fixtures[1]?.events[0], workspaceId: "ws_123e4567-e89b-42d3-a456-426614174099" }
        ]
      })
    ).toThrow();
  });

  it("rejects corrupt stored stream metadata", () => {
    const event = {
      ...context,
      type: "run.created",
      payload: { run },
      eventId: "evt_123e4567-e89b-42d3-a456-426614174000",
      stream: { kind: "run", id: WORK_ITEM_ID },
      streamVersion: 1,
      globalSequence: 1,
      schemaVersion: 1
    };
    expect(() => StoredDomainEventSchema.parse(event)).toThrow();
    expect(() =>
      StoredDomainEventSchema.parse({
        ...event,
        stream: { kind: "run", id: RUN_ID },
        workspaceId: "ws_123e4567-e89b-42d3-a456-426614174099"
      })
    ).toThrow();
  });
});
