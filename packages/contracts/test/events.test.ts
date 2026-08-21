import { describe, expect, it } from "vitest";

import {
  EVENT_TYPES,
  PendingDomainEventSchema,
  StoredDomainEventSchema,
  digestLocalExecutionPhase,
  parseStoredDomainEvent,
  digestTerminalRunTransition,
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
const PERMISSION_APPROVAL_ID = "apr_123e4567-e89b-42d3-a456-426614174002";
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
    approvalId: PERMISSION_APPROVAL_ID,
    approvalEvidenceDigest: await digestCommandScope(commandScope),
    scope: commandScope,
    createdAt: NOW,
    expiresAt: "2026-08-21T13:00:00.000Z"
  };
  commandAuthorization.digest = await digestCommandAuthorization(commandAuthorization);
  const planApproval = {
    schemaVersion: 1,
    id: APPROVAL_ID,
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    kind: "plan" as const,
    status: "pending" as const,
    evidenceDigest: environmentAuthorization.approvalEvidenceDigest,
    eligibleApproverIds: ["local-user"],
    createdAt: NOW,
    updatedAt: NOW
  };
  const permissionApproval = {
    schemaVersion: 1,
    id: PERMISSION_APPROVAL_ID,
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    kind: "permission" as const,
    status: "pending" as const,
    evidenceDigest: commandAuthorization.approvalEvidenceDigest,
    eligibleApproverIds: ["local-user"],
    createdAt: NOW,
    updatedAt: NOW
  };
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
  const bodies = [
    { type: "approval.requested" as const, payload: { approval: planApproval } },
    {
      type: "approval.decided" as const,
      payload: {
        approvalId: APPROVAL_ID,
        runId: RUN_ID,
        decision: "approved" as const,
        evidenceDigest: planApproval.evidenceDigest,
        origin: "desktop" as const,
        decidedAt: NOW
      }
    },
    {
      type: "environment.authorization_recorded",
      payload: {
        runId: RUN_ID,
        environmentId,
        authorization: environmentAuthorization,
        phaseKey: `environment:${environmentId}:authorization`
      }
    },
    { type: "approval.requested" as const, payload: { approval: permissionApproval } },
    {
      type: "approval.decided" as const,
      payload: {
        approvalId: PERMISSION_APPROVAL_ID,
        runId: RUN_ID,
        decision: "approved" as const,
        evidenceDigest: permissionApproval.evidenceDigest,
        origin: "desktop" as const,
        decidedAt: NOW
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
          state: "prepared",
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
        phaseKey: `command:${commandId}:artifact:${artifact.artifactId}`
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
  return Promise.all(
    bodies.map(async (body) => ({
      ...body,
      payload: {
        ...body.payload,
        phaseDigest: await digestLocalExecutionPhase(body.type, body.payload)
      }
    }))
  );
};

describe("domain event contracts", () => {
  it("rejects a local command completion that lacks prior durable intent and artifact evidence", async () => {
    const payload = {
      runId: RUN_ID,
      environmentId: "env_123e4567-e89b-42d3-a456-426614174000",
      commandId: "cmd_123e4567-e89b-42d3-a456-426614174000",
      terminalSequence: 1,
      terminalDigest: "a".repeat(64),
      status: "completed" as const,
      completedAt: NOW,
      phaseKey: "command:cmd_123e4567-e89b-42d3-a456-426614174000:completed"
    };
    await expect(
      validateRunStreamCoherence([
        {
          ...context,
          type: "command.completed",
          payload: {
            ...payload,
            phaseDigest: await digestLocalExecutionPhase("command.completed", payload)
          }
        }
      ])
    ).rejects.toThrow(/intent/i);
  });

  it("records only safe canonical local execution evidence on the run stream", async () => {
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
    const recordedPayload = {
      runId: RUN_ID,
      environmentId: authorization.scope.environmentId,
      authorization,
      phaseKey: `environment:${authorization.scope.environmentId}:authorization`
    };
    const recorded = PendingDomainEventSchema.parse({
      ...context,
      type: "environment.authorization_recorded",
      payload: {
        ...recordedPayload,
        phaseDigest: await digestLocalExecutionPhase(
          "environment.authorization_recorded",
          recordedPayload
        )
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
          authorization,
          phaseKey: `environment:${authorization.scope.environmentId}:authorization`
        }
      })
    ).toThrow(/phaseDigest/i);
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

    expect([...new Set(parsedTypes.map(({ type }) => type))].sort()).toEqual(
      [...EVENT_TYPES].sort()
    );
  });

  it("accepts one ordered local execution evidence stream", async () => {
    const localBodies = await localEventBodies();
    const disposalIndex = localBodies.findIndex((body) => body.type === "environment.disposed");
    if (disposalIndex === -1) throw new TypeError("Fixture is missing disposal evidence.");
    const disposal = localBodies[disposalIndex];
    if (disposal?.type !== "environment.disposed") {
      throw new TypeError("Fixture disposal evidence is invalid.");
    }
    const terminalTransition = {
      ...context,
      type: "run.transitioned" as const,
      payload: {
        runId: RUN_ID,
        from: "implementing" as const,
        to: "completed" as const,
        reason: "execution completed"
      },
      eventId: EVENT_ID,
      stream: { kind: "run" as const, id: RUN_ID },
      streamVersion: 100,
      globalSequence: 100,
      schemaVersion: 1 as const
    };
    const terminalRunEvidence = {
      status: "completed" as const,
      terminalEventSequence: 100,
      terminalEventDigest: await digestTerminalRunTransition(terminalTransition)
    };
    const disposalPayload = { ...disposal.payload, terminalRunEvidence };
    const disposalEvent = {
      ...context,
      ...disposal,
      payload: {
        ...disposalPayload,
        phaseDigest: await digestLocalExecutionPhase(disposal.type, disposalPayload)
      }
    };
    const events = [
      ...localBodies.slice(0, disposalIndex).map((body) => ({ ...context, ...body })),
      terminalTransition,
      disposalEvent
    ];
    await expect(validateRunStreamCoherence(events)).resolves.toHaveLength(14);
    await expect(
      validateRunStreamCoherence([{ ...context, ...eventBodies[0] }])
    ).resolves.toHaveLength(1);
    await expect(validateRunStreamCoherence([...events, events[13]])).resolves.toHaveLength(15);
    await expect(validateRunStreamCoherence(events.slice(1))).rejects.toThrow(/approval/i);
    await expect(validateRunStreamCoherence(events.slice(2, 3))).rejects.toThrow(/approved plan/i);
    await expect(validateRunStreamCoherence([events[7]])).rejects.toThrow(/prepare intent/i);
    await expect(
      validateRunStreamCoherence(events.filter((event) => event.type !== "artifact.recorded"))
    ).rejects.toThrow(/artifact evidence/i);
    await expect(
      (async () => {
        const replay = events[13];
        if (replay === undefined) throw new TypeError("Fixture is missing disposal evidence.");
        const payload = {
          ...replay.payload,
          phaseKey: "environment:env_123e4567-e89b-42d3-a456-426614174000:prepared"
        };
        return validateRunStreamCoherence([
          ...events.slice(0, 13),
          {
            ...replay,
            payload: {
              ...payload,
              phaseDigest: await digestLocalExecutionPhase(replay.type, payload)
            }
          }
        ]);
      })()
    ).rejects.toThrow(/collision/i);
  });

  it("rejects execution evidence after an environment is disposed", async () => {
    const localBodies = await localEventBodies();
    const disposalIndex = localBodies.findIndex((body) => body.type === "environment.disposed");
    if (disposalIndex === -1) throw new TypeError("Fixture is missing disposal evidence.");
    const disposal = localBodies[disposalIndex];
    if (disposal?.type !== "environment.disposed") {
      throw new TypeError("Fixture disposal evidence is invalid.");
    }
    const terminalTransition = {
      ...context,
      type: "run.transitioned" as const,
      payload: {
        runId: RUN_ID,
        from: "implementing" as const,
        to: "completed" as const,
        reason: "execution completed"
      },
      eventId: EVENT_ID,
      stream: { kind: "run" as const, id: RUN_ID },
      streamVersion: 100,
      globalSequence: 100,
      schemaVersion: 1 as const
    };
    const terminalRunEvidence = {
      status: "completed" as const,
      terminalEventSequence: 100,
      terminalEventDigest: await digestTerminalRunTransition(terminalTransition)
    };
    const disposalPayload = { ...disposal.payload, terminalRunEvidence };
    const disposalEvent = {
      ...context,
      ...disposal,
      payload: {
        ...disposalPayload,
        phaseDigest: await digestLocalExecutionPhase(disposal.type, disposalPayload)
      }
    };
    const originalArtifact = localBodies.find((body) => body.type === "artifact.recorded");
    if (originalArtifact?.type !== "artifact.recorded") {
      throw new TypeError("Fixture is missing artifact evidence.");
    }
    const postDisposalPayload = {
      ...originalArtifact.payload,
      artifact: {
        ...originalArtifact.payload.artifact,
        artifactId: "art_123e4567-e89b-42d3-a456-426614174099"
      },
      phaseKey:
        "command:cmd_123e4567-e89b-42d3-a456-426614174000:artifact:art_123e4567-e89b-42d3-a456-426614174099"
    };
    const events = [
      ...localBodies.slice(0, disposalIndex).map((body) => ({ ...context, ...body })),
      terminalTransition,
      disposalEvent,
      {
        ...context,
        type: "artifact.recorded" as const,
        payload: {
          ...postDisposalPayload,
          phaseDigest: await digestLocalExecutionPhase("artifact.recorded", postDisposalPayload)
        }
      }
    ];

    await expect(validateRunStreamCoherence(events)).rejects.toThrow(/disposed|terminal/i);
  });

  it("applies command authorization narrowing when durable evidence is recorded", async () => {
    const bodies = await localEventBodies();
    const permissionRequested = bodies.find(
      (body) =>
        body.type === "approval.requested" &&
        "approval" in body.payload &&
        body.payload.approval.kind === "permission"
    );
    const permissionDecided = bodies.find(
      (body) =>
        body.type === "approval.decided" && body.payload.approvalId === PERMISSION_APPROVAL_ID
    );
    const commandRecorded = bodies.find((body) => body.type === "command.authorization_recorded");
    if (
      permissionRequested?.type !== "approval.requested" ||
      permissionDecided?.type !== "approval.decided" ||
      commandRecorded?.type !== "command.authorization_recorded" ||
      !("approval" in permissionRequested.payload) ||
      !("authorization" in commandRecorded.payload)
    ) {
      throw new TypeError("Fixture is missing permission authorization evidence.");
    }
    const scope = {
      ...commandRecorded.payload.authorization.scope,
      repositoryIdentity: "github:autostack/broadened"
    };
    const authorization = {
      ...commandRecorded.payload.authorization,
      digest: "0".repeat(64),
      approvalEvidenceDigest: await digestCommandScope(scope),
      scope
    };
    authorization.digest = await digestCommandAuthorization(authorization);
    const commandPayload = { ...commandRecorded.payload, authorization };
    const commandEvent = {
      ...context,
      ...commandRecorded,
      payload: {
        ...commandPayload,
        phaseDigest: await digestLocalExecutionPhase(
          "command.authorization_recorded",
          commandPayload
        )
      }
    };
    const permissionApproval = {
      ...permissionRequested.payload.approval,
      evidenceDigest: authorization.approvalEvidenceDigest
    };
    const events = [
      ...bodies.slice(0, 3).map((body) => ({ ...context, ...body })),
      {
        ...context,
        ...permissionRequested,
        payload: { approval: permissionApproval }
      },
      {
        ...context,
        ...permissionDecided,
        payload: {
          ...permissionDecided.payload,
          evidenceDigest: permissionApproval.evidenceDigest
        }
      },
      commandEvent
    ];

    await expect(validateRunStreamCoherence(events)).rejects.toThrow(/broaden/i);
  });

  it("uses each phase timestamp and exact prepared authorization record", async () => {
    const bodies = await localEventBodies();
    const prepare = bodies.find((body) => body.type === "environment.prepare_requested");
    const prepared = bodies.find((body) => body.type === "environment.prepared");
    if (
      prepare?.type !== "environment.prepare_requested" ||
      prepared?.type !== "environment.prepared" ||
      !("environment" in prepared.payload)
    ) {
      throw new TypeError("Fixture is missing prepare evidence.");
    }
    await expect(
      validateRunStreamCoherence([
        ...bodies.slice(0, 6).map((body) => ({ ...context, ...body })),
        { ...context, ...prepare, occurredAt: "2026-08-21T13:00:00.000Z" }
      ])
    ).rejects.toThrow(/active|expired/i);

    const alteredAuthorization = {
      ...prepared.payload.environment.authorization,
      digest: "0".repeat(64),
      expiresAt: "2026-08-21T14:00:00.000Z"
    };
    alteredAuthorization.digest = await digestEnvironmentAuthorization(alteredAuthorization);
    const preparedPayload = {
      ...prepared.payload,
      environment: { ...prepared.payload.environment, authorization: alteredAuthorization }
    };
    await expect(
      validateRunStreamCoherence([
        ...bodies.slice(0, 7).map((body) => ({ ...context, ...body })),
        {
          ...context,
          ...prepared,
          payload: {
            ...preparedPayload,
            phaseDigest: await digestLocalExecutionPhase("environment.prepared", preparedPayload)
          }
        }
      ])
    ).rejects.toThrow(/prepare intent/i);
  });

  it("binds artifact evidence to the command intent run and environment", async () => {
    const bodies = await localEventBodies();
    const artifact = bodies.find((body) => body.type === "artifact.recorded");
    if (artifact?.type !== "artifact.recorded") {
      throw new TypeError("Fixture is missing artifact evidence.");
    }
    const wrongRunId = "run_123e4567-e89b-42d3-a456-426614174099";
    const artifactPayload = {
      ...artifact.payload,
      runId: wrongRunId,
      artifact: { ...artifact.payload.artifact, runId: wrongRunId }
    };
    await expect(
      validateRunStreamCoherence([
        ...bodies.slice(0, 9).map((body) => ({ ...context, ...body })),
        {
          ...context,
          ...artifact,
          payload: {
            ...artifactPayload,
            phaseDigest: await digestLocalExecutionPhase("artifact.recorded", artifactPayload)
          }
        }
      ])
    ).rejects.toThrow(/artifact/i);
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
