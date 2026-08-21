import { describe, expect, it } from "vitest";

import { StoredDomainEventSchema, type StoredDomainEvent } from "@autostack/contracts";

import { ProjectionOrderError, projectRunSummaries } from "../src/projections.js";

const NOW = "2026-08-20T12:00:00.000Z";
const LATER = "2026-08-20T12:01:00.000Z";
const WORKSPACE_ID = "ws_123e4567-e89b-42d3-a456-426614174000";
const WORK_ITEM_ID = "wi_123e4567-e89b-42d3-a456-426614174000";
const RUN_ID = "run_123e4567-e89b-42d3-a456-426614174000";
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174001";

const base = {
  workspaceId: WORKSPACE_ID,
  actor: { kind: "system", id: "autostack" },
  correlationId: CORRELATION_ID,
  schemaVersion: 1
} as const;

const workItem = {
  schemaVersion: 1,
  id: WORK_ITEM_ID,
  workspaceId: WORKSPACE_ID,
  source: { kind: "manual", client: "web" },
  title: "Build projections",
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

const events = (): StoredDomainEvent[] => [
  StoredDomainEventSchema.parse({
    ...base,
    eventId: "evt_123e4567-e89b-42d3-a456-426614174010",
    stream: { kind: "work_item", id: WORK_ITEM_ID },
    streamVersion: 1,
    globalSequence: 1,
    occurredAt: NOW,
    type: "work_item.created",
    payload: { workItem }
  }),
  StoredDomainEventSchema.parse({
    ...base,
    eventId: "evt_123e4567-e89b-42d3-a456-426614174011",
    stream: { kind: "run", id: RUN_ID },
    streamVersion: 1,
    globalSequence: 2,
    occurredAt: NOW,
    type: "run.created",
    payload: { run }
  }),
  StoredDomainEventSchema.parse({
    ...base,
    eventId: "evt_123e4567-e89b-42d3-a456-426614174012",
    stream: { kind: "run", id: RUN_ID },
    streamVersion: 2,
    globalSequence: 3,
    occurredAt: LATER,
    type: "run.transitioned",
    payload: { runId: RUN_ID, from: "queued", to: "triaging", reason: "work started" }
  })
];

describe("run summary projections", () => {
  it("rebuilds the latest run state from ordered events", () => {
    expect(projectRunSummaries(events())).toEqual([
      {
        runId: RUN_ID,
        workItemId: WORK_ITEM_ID,
        title: "Build projections",
        source: "manual",
        status: "triaging",
        currentStage: "triage",
        lastGlobalSequence: 3,
        createdAt: NOW,
        updatedAt: LATER
      }
    ]);
  });

  it("ignores stage events for a run that has no creation event", () => {
    const unrelated = StoredDomainEventSchema.parse({
      ...base,
      eventId: "evt_123e4567-e89b-42d3-a456-426614174013",
      stream: { kind: "run", id: "run_123e4567-e89b-42d3-a456-426614174099" },
      streamVersion: 1,
      globalSequence: 4,
      occurredAt: LATER,
      type: "stage.queued",
      payload: {
        runId: "run_123e4567-e89b-42d3-a456-426614174099",
        stage: "plan",
        jobId: "job_123e4567-e89b-42d3-a456-426614174099"
      }
    });

    expect(projectRunSummaries([...events(), unrelated])).toHaveLength(1);
  });

  it("rejects duplicate or descending stream versions", () => {
    const invalid = StoredDomainEventSchema.parse({ ...events()[2]!, streamVersion: 1 });

    expect(() => projectRunSummaries([...events().slice(0, 2), invalid])).toThrow(
      ProjectionOrderError
    );
  });

  it("rejects descending global event order", () => {
    expect(() => projectRunSummaries([events()[1]!, events()[0]!])).toThrow(ProjectionOrderError);
  });
});
