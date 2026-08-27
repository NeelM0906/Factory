import { describe, expect, it } from "vitest";

import {
  NewWorkflowJobSchema,
  PendingDomainEventSchema,
  WorkspaceIdSchema,
  createIdFactory,
  type Actor
} from "@autostack/contracts";

import { intakeWorkItem } from "../src/intake-work-item.js";

const NOW = "2026-08-20T12:00:00.000Z";
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174001");
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174002";
const ACTOR: Actor = { kind: "integration", id: "webhook", provider: "github" };

const dependencies = {
  now: () => NOW,
  ids: createIdFactory(() => UUID)
};

const context = {
  workspaceId: WORKSPACE_ID,
  actor: ACTOR,
  correlationId: CORRELATION_ID
};

const requester = { externalId: "octocat" };

describe("work item intake", () => {
  it("intakes a github source and produces created events plus a queued triage job", () => {
    const decision = intakeWorkItem(
      {
        source: {
          kind: "github",
          repositoryFullName: "autostack/autostack",
          issueNumber: 42,
          deliveryId: "d-1"
        },
        title: "Fix the flaky test",
        requester,
        priority: "normal",
        labels: [],
        acceptanceContext: []
      },
      context,
      dependencies
    );

    expect(decision.workItem).toMatchObject({
      id: `wi_${UUID}`,
      title: "Fix the flaky test",
      source: { kind: "github", deliveryId: "d-1" }
    });
    expect(decision.run).toMatchObject({
      id: `run_${UUID}`,
      workItemId: `wi_${UUID}`,
      status: "queued"
    });
    expect(decision.appends).toHaveLength(2);
    expect(decision.appends.map(({ stream }) => stream.kind)).toEqual(["work_item", "run"]);
    expect(decision.appends.map(({ expectedVersion }) => expectedVersion)).toEqual([0, 0]);
    expect(decision.appends[0]?.events[0]?.type).toBe("work_item.created");
    expect(decision.appends[1]?.events[0]?.type).toBe("run.created");
    expect(decision.jobs).toHaveLength(1);
    expect(decision.jobs[0]).toMatchObject({
      handler: "pipeline.triage",
      stage: "triage",
      maxAttempts: 3,
      runId: decision.run.id,
      workspaceId: WORKSPACE_ID,
      availableAt: NOW,
      createdAt: NOW
    });
    // The payload must stay parseable by `PipelineJobPayloadSchema` (plan Task 3), which the
    // handler registry applies before any station code runs. Asserted exactly — not with
    // `toMatchObject` — so an added or renamed field fails here rather than at the registry.
    expect(decision.jobs[0]?.payload).toEqual({
      workItemId: decision.workItem.id,
      pipelineStage: "triage",
      attempt: 1,
      inputEvidenceDigests: []
    });
    expect(decision.idempotency).toEqual({
      scope: `intake:github:${WORKSPACE_ID}`,
      key: "d-1"
    });
  });

  it("derives the same idempotency descriptor for the same deliveryId across calls", () => {
    const input = {
      source: {
        kind: "github" as const,
        repositoryFullName: "autostack/autostack",
        issueNumber: 42,
        deliveryId: "d-1"
      },
      title: "Fix the flaky test",
      requester,
      priority: "normal" as const,
      labels: [],
      acceptanceContext: []
    };

    const first = intakeWorkItem(input, context, dependencies);
    const second = intakeWorkItem(input, context, dependencies);

    expect(first.idempotency).toEqual(second.idempotency);
    expect(first.idempotency).toEqual({ scope: `intake:github:${WORKSPACE_ID}`, key: "d-1" });
  });

  it("derives a different idempotency key for a different deliveryId", () => {
    const base = {
      title: "Fix the flaky test",
      requester,
      priority: "normal" as const,
      labels: [],
      acceptanceContext: []
    };

    const first = intakeWorkItem(
      {
        ...base,
        source: {
          kind: "github" as const,
          repositoryFullName: "autostack/autostack",
          issueNumber: 42,
          deliveryId: "d-1"
        }
      },
      context,
      dependencies
    );
    const second = intakeWorkItem(
      {
        ...base,
        source: {
          kind: "github" as const,
          repositoryFullName: "autostack/autostack",
          issueNumber: 42,
          deliveryId: "d-2"
        }
      },
      context,
      dependencies
    );

    expect(first.idempotency).not.toEqual(second.idempotency);
    expect(second.idempotency).toEqual({ scope: `intake:github:${WORKSPACE_ID}`, key: "d-2" });
  });

  it("dedupes a slack source on its own deliveryId and scope", () => {
    const decision = intakeWorkItem(
      {
        source: {
          kind: "slack",
          slackWorkspaceId: "T123",
          channelId: "C456",
          threadTs: "1234.5678",
          deliveryId: "d-slack-1"
        },
        title: "Investigate the alert",
        requester,
        priority: "normal",
        labels: [],
        acceptanceContext: []
      },
      context,
      dependencies
    );

    expect(decision.idempotency).toEqual({
      scope: `intake:slack:${WORKSPACE_ID}`,
      key: "d-slack-1"
    });
  });

  it("dedupes an api source on its own deliveryId and scope", () => {
    const decision = intakeWorkItem(
      {
        source: { kind: "api", clientId: "cli-1", deliveryId: "d-api-1" },
        title: "Automated import",
        requester,
        priority: "normal",
        labels: [],
        acceptanceContext: []
      },
      context,
      dependencies
    );

    expect(decision.idempotency).toEqual({
      scope: `intake:api:${WORKSPACE_ID}`,
      key: "d-api-1"
    });
  });

  it("falls back to the caller-supplied key for a manual source", () => {
    const decision = intakeWorkItem(
      {
        source: { kind: "manual", client: "web" },
        title: "Manually filed bug",
        requester,
        priority: "normal",
        labels: [],
        acceptanceContext: [],
        manualIdempotencyKey: "manual-key-1"
      },
      context,
      dependencies
    );

    expect(decision.idempotency).toEqual({
      scope: `intake:manual:${WORKSPACE_ID}`,
      key: "manual-key-1"
    });
  });

  it("rejects a manual source with no caller-supplied idempotency key", () => {
    expect(() =>
      intakeWorkItem(
        {
          source: { kind: "manual", client: "web" },
          title: "Manually filed bug",
          requester,
          priority: "normal",
          labels: [],
          acceptanceContext: []
        },
        context,
        dependencies
      )
    ).toThrow();
  });

  it("produces byte-identical output for identical injected now/ids across calls", () => {
    const input = {
      source: {
        kind: "github" as const,
        repositoryFullName: "autostack/autostack",
        issueNumber: 7,
        deliveryId: "d-deterministic"
      },
      title: "Deterministic decision",
      requester,
      priority: "normal" as const,
      labels: [],
      acceptanceContext: []
    };

    const first = intakeWorkItem(input, context, dependencies);
    const second = intakeWorkItem(input, context, dependencies);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("produces events and a job that pass contract validation", () => {
    const decision = intakeWorkItem(
      {
        source: {
          kind: "github",
          repositoryFullName: "autostack/autostack",
          issueNumber: 42,
          deliveryId: "d-validated"
        },
        title: "Validate contract shapes",
        requester,
        priority: "normal",
        labels: [],
        acceptanceContext: []
      },
      context,
      dependencies
    );

    for (const append of decision.appends) {
      for (const event of append.events) {
        expect(() => PendingDomainEventSchema.parse(event)).not.toThrow();
      }
    }
    for (const job of decision.jobs) {
      expect(() => NewWorkflowJobSchema.parse(job)).not.toThrow();
    }
  });
});
