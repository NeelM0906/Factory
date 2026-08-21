import { describe, expect, it } from "vitest";

import {
  EVENT_TYPES,
  PendingDomainEventSchema,
  StoredDomainEventSchema,
  parseStoredDomainEvent,
  validateRunStreamCoherence
} from "../src/events.js";
import {
  digestCommandAuthorization,
  digestCommandScope,
  digestCommandSpec,
  digestEnvironmentAuthorization,
  digestExecutionScope
} from "../src/runner.js";

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
      error: {
        code: "provider_unavailable",
        name: "ProviderError",
        message: "temporarily unavailable",
        retryable: true
      }
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

const localEventBodies = async () => {
  const environmentId = "env_123e4567-e89b-42d3-a456-426614174000";
  const commandId = "cmd_123e4567-e89b-42d3-a456-426614174000";
  const environmentAuthorizationId = "envauth_123e4567-e89b-42d3-a456-426614174000";
  const commandAuthorizationId = "cmdauth_123e4567-e89b-42d3-a456-426614174000";
  const scope = {
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    environmentId,
    repositoryIdentity: "github:autostack/contracts",
    sourceCommit: "c".repeat(40),
    branch: "autostack/events",
    cwdRoot: ".",
    resourceLimits: { cpu: 2, memoryMb: 2048, durationSeconds: 600 },
    networkPolicy: "host",
    filesystemDisclosure: "host_user",
    allowedCredentialRefIds: []
  };
  const environmentAuthorization = {
    id: environmentAuthorizationId,
    digest: "0".repeat(64),
    approvalId: APPROVAL_ID,
    approvalEvidenceDigest: await digestExecutionScope(scope),
    scope,
    createdAt: NOW,
    expiresAt: "2026-08-21T13:00:00.000Z"
  };
  environmentAuthorization.digest = await digestEnvironmentAuthorization(environmentAuthorization);
  const command = {
    executable: "true",
    args: [],
    cwd: ".",
    environment: [],
    timeoutSeconds: 60,
    terminal: { columns: 80, rows: 24 }
  };
  const commandScope = {
    environmentAuthorizationId,
    environmentAuthorizationDigest: environmentAuthorization.digest,
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    environmentId,
    commandId,
    action: "implement",
    commandDigest: await digestCommandSpec(command),
    repositoryIdentity: scope.repositoryIdentity,
    sourceCommit: scope.sourceCommit,
    branch: scope.branch,
    cwdRoot: scope.cwdRoot,
    networkPolicy: "host",
    filesystemDisclosure: "host_user",
    resourceLimits: scope.resourceLimits,
    allowedCredentialRefIds: []
  };
  const commandAuthorization = {
    id: commandAuthorizationId,
    digest: "0".repeat(64),
    approvalId: APPROVAL_ID,
    approvalEvidenceDigest: await digestCommandScope(commandScope),
    scope: commandScope,
    createdAt: NOW,
    expiresAt: "2026-08-21T13:00:00.000Z"
  };
  commandAuthorization.digest = await digestCommandAuthorization(commandAuthorization);
  const inspection = {
    repositoryIdentity: scope.repositoryIdentity,
    canonicalSourcePath: "/source",
    repositoryCommonDirectory: "/source/.git",
    resolvedBaseRef: "main",
    sourceCommit: scope.sourceCommit,
    dirty: false,
    diagnostics: []
  };
  const prepare = {
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    environmentId,
    inspection,
    sourceCommit: scope.sourceCommit,
    branch: scope.branch,
    authorization: environmentAuthorization,
    idempotency: { key: "prepare" }
  };
  const start = {
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    environmentId,
    commandId,
    command,
    environmentAuthorizationId,
    environmentAuthorizationDigest: environmentAuthorization.digest,
    authorization: commandAuthorization,
    idempotency: { key: "start" }
  };
  const artifact = {
    artifactId: "art_123e4567-e89b-42d3-a456-426614174000",
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    commandId,
    kind: "command_transcript",
    mediaType: "text/plain",
    digest: "a".repeat(64),
    byteSize: 0,
    createdAt: NOW
  };
  return [
    {
      type: "environment.authorization_recorded",
      payload: {
        runId: RUN_ID,
        environmentId,
        authorization: environmentAuthorization,
        phaseKey: `environment:${environmentId}:authorization`
      }
    },
    {
      type: "command.authorization_recorded",
      payload: {
        runId: RUN_ID,
        environmentId,
        commandId,
        authorization: commandAuthorization,
        phaseKey: `command:${commandId}:authorization`
      }
    },
    {
      type: "environment.prepare_requested",
      payload: { request: prepare, phaseKey: `environment:${environmentId}:intent` }
    },
    {
      type: "environment.prepared",
      payload: {
        environment: {
          environmentId,
          workspaceId: WORKSPACE_ID,
          runId: RUN_ID,
          repositoryIdentity: scope.repositoryIdentity,
          sourceCommit: scope.sourceCommit,
          branch: scope.branch,
          authorization: environmentAuthorization,
          preparedAt: NOW
        },
        phaseKey: `environment:${environmentId}:prepared`
      }
    },
    {
      type: "command.intent_recorded",
      payload: { request: start, phaseKey: `command:${commandId}:intent` }
    },
    {
      type: "command.started",
      payload: {
        runId: RUN_ID,
        environmentId,
        commandId,
        startedAt: NOW,
        phaseKey: `command:${commandId}:started`
      }
    },
    {
      type: "artifact.recorded",
      payload: {
        runId: RUN_ID,
        environmentId,
        commandId,
        artifact,
        phaseKey: `command:${commandId}:artifact`
      }
    },
    {
      type: "command.completed",
      payload: {
        runId: RUN_ID,
        environmentId,
        commandId,
        terminalSequence: 3,
        terminalDigest: "a".repeat(64),
        status: "completed",
        completedAt: NOW,
        phaseKey: `command:${commandId}:completed`
      }
    },
    {
      type: "environment.disposed",
      payload: {
        runId: RUN_ID,
        environmentId,
        environmentAuthorizationId,
        environmentAuthorizationDigest: environmentAuthorization.digest,
        terminalRunEvidence: {
          status: "completed",
          terminalEventSequence: 3,
          terminalEventDigest: "a".repeat(64)
        },
        disposedAt: NOW,
        phaseKey: `environment:${environmentId}:disposed`
      }
    }
  ];
};

describe("domain event contracts", () => {
  it("rejects a local command completion that lacks prior durable intent and artifact evidence", async () => {
    await expect(
      validateRunStreamCoherence([
        {
          ...context,
          type: "command.completed",
          payload: {
            runId: RUN_ID,
            environmentId: "env_123e4567-e89b-42d3-a456-426614174000",
            commandId: "cmd_123e4567-e89b-42d3-a456-426614174000",
            terminalSequence: 1,
            terminalDigest: "a".repeat(64),
            status: "completed",
            completedAt: NOW,
            phaseKey: "command:cmd_123e4567-e89b-42d3-a456-426614174000:completed"
          }
        }
      ])
    ).rejects.toThrow(/intent/i);
  });

  it("records only safe canonical local execution evidence on the run stream", () => {
    const authorization = {
      id: "envauth_123e4567-e89b-42d3-a456-426614174000",
      digest: "a".repeat(64),
      approvalId: APPROVAL_ID,
      approvalEvidenceDigest: "b".repeat(64),
      scope: {
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        environmentId: "env_123e4567-e89b-42d3-a456-426614174000",
        repositoryIdentity: "github:autostack/contracts",
        sourceCommit: "c".repeat(40),
        branch: "autostack/event-evidence",
        cwdRoot: ".",
        resourceLimits: { cpu: 2, memoryMb: 2048, durationSeconds: 600 },
        networkPolicy: "host",
        filesystemDisclosure: "host_user",
        allowedCredentialRefIds: []
      },
      createdAt: NOW,
      expiresAt: "2026-08-21T13:00:00.000Z"
    };
    const recorded = PendingDomainEventSchema.parse({
      ...context,
      type: "environment.authorization_recorded",
      payload: {
        runId: RUN_ID,
        environmentId: authorization.scope.environmentId,
        authorization,
        phaseKey: `environment:${authorization.scope.environmentId}:authorization`
      }
    });
    expect(recorded.type).toBe("environment.authorization_recorded");
    expect(() =>
      PendingDomainEventSchema.parse({
        ...context,
        type: "environment.authorization_recorded",
        payload: {
          runId: RUN_ID,
          environmentId: authorization.scope.environmentId,
          authorization: {
            ...authorization,
            scope: { ...authorization.scope, repositoryIdentity: "ghp_0123456789abcdefghijklmnop" }
          },
          phaseKey: `environment:${authorization.scope.environmentId}:authorization`
        }
      })
    ).toThrow();
    expect(() =>
      PendingDomainEventSchema.parse({
        ...context,
        workspaceId: "ws_123e4567-e89b-42d3-a456-426614174099",
        type: "environment.authorization_recorded",
        payload: {
          runId: RUN_ID,
          environmentId: authorization.scope.environmentId,
          authorization,
          phaseKey: `environment:${authorization.scope.environmentId}:authorization`
        }
      })
    ).toThrow();
  });

  it("covers every declared event type with a valid payload fixture", async () => {
    const parsedTypes = [...eventBodies, ...(await localEventBodies())].map((body) =>
      PendingDomainEventSchema.parse({ ...context, ...body })
    );

    expect(parsedTypes.map(({ type }) => type).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it("accepts one ordered local execution evidence stream", async () => {
    const events = (await localEventBodies()).map((body) => ({ ...context, ...body }));
    await expect(validateRunStreamCoherence(events)).resolves.toHaveLength(9);
    await expect(
      validateRunStreamCoherence([{ ...context, ...eventBodies[0] }])
    ).resolves.toHaveLength(1);
    await expect(validateRunStreamCoherence([...events, events[8]])).rejects.toThrow(/collision/i);
    await expect(validateRunStreamCoherence(events.slice(1))).rejects.toThrow(
      /environment authorization/i
    );
    await expect(validateRunStreamCoherence([events[3]])).rejects.toThrow(/prepare intent/i);
    await expect(
      validateRunStreamCoherence(events.filter((event) => event.type !== "artifact.recorded"))
    ).rejects.toThrow(/artifact evidence/i);
    await expect(
      validateRunStreamCoherence([
        ...events.slice(0, 8),
        {
          ...events[8],
          payload: {
            ...events[8]?.payload,
            phaseKey: "environment:env_123e4567-e89b-42d3-a456-426614174000:prepared"
          }
        }
      ])
    ).rejects.toThrow(/phase key/i);
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

  it("decodes legacy v1 stage failures while preserving strict new records", () => {
    const metadata = {
      ...context,
      eventId: EVENT_ID,
      stream: { kind: "run", id: RUN_ID },
      streamVersion: 1,
      globalSequence: 1,
      schemaVersion: 1
    } as const;
    const current = { ...metadata, ...eventBodies[1] };
    expect(parseStoredDomainEvent(current)).toMatchObject({ type: "run.created" });
    const stageFailure = {
      ...metadata,
      streamVersion: 2,
      globalSequence: 2,
      ...eventBodies[6]
    };
    const legacy = {
      ...stageFailure,
      payload: {
        ...stageFailure.payload,
        error: { name: "ProviderError", message: "legacy failure", retryable: false }
      }
    };
    expect(parseStoredDomainEvent(legacy)).toMatchObject({
      payload: { error: { code: "legacy_workflow_failure" } }
    });
    expect(parseStoredDomainEvent(stageFailure)).toMatchObject({
      payload: { error: { code: "provider_unavailable" } }
    });
    for (const malformed of [null, [], { ...legacy, payload: null }, { ...legacy, payload: [] }]) {
      expect(() => parseStoredDomainEvent(malformed)).toThrow();
    }
  });
});
