import { z } from "zod";

import {
  ActorSchema,
  ApprovalSchema,
  RunSchema,
  RunStageSchema,
  RunStatusSchema,
  WorkItemSchema
} from "./entities.js";
import {
  ApprovalIdSchema,
  CommandIdSchema,
  EnvironmentAuthorizationIdSchema,
  EnvironmentIdSchema,
  EventIdSchema,
  JobIdSchema,
  RunIdSchema,
  WorkspaceIdSchema
} from "./ids.js";
import {
  ArtifactDescriptorSchema,
  CommandAuthorizationSchema,
  EnvironmentAuthorizationSchema,
  PrepareEnvironmentRequestSchema,
  PreparedEnvironmentSchema,
  StartCommandRequestSchema,
  TerminalRunEvidenceSchema,
  type CommandAuthorization,
  type EnvironmentAuthorization,
  type PreparedEnvironment,
  type PrepareEnvironmentRequest,
  type StartCommandRequest,
  type TerminalRunEvidence,
  admitPrepareEnvironment,
  admitStartCommand,
  canonicalizeCommandAuthorizationForDigest,
  canonicalizeEnvironmentAuthorizationForDigest,
  canonicalizeVersionedDigestValue,
  digestVersionedValue,
  digestCommandAuthorization,
  digestCommandScope,
  digestEnvironmentAuthorization,
  digestExecutionScope,
  validateCommandAuthorizationAgainstEnvironment
} from "./runner.js";
import { normalizeSafeJson, type SafeJsonValue } from "./secret-safety.js";
import { WorkflowFailureSchema } from "./workflow-failure.js";

export const EVENT_TYPES = [
  "work_item.created",
  "run.created",
  "run.transitioned",
  "stage.queued",
  "stage.leased",
  "stage.succeeded",
  "stage.failed",
  "approval.requested",
  "approval.decided",
  "environment.authorization_recorded",
  "command.authorization_recorded",
  "environment.prepare_requested",
  "environment.prepared",
  "command.intent_recorded",
  "command.started",
  "command.completed",
  "artifact.recorded",
  "environment.disposed"
] as const;

const EventContextSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    actor: ActorSchema,
    correlationId: z.uuid(),
    causationId: EventIdSchema.optional(),
    occurredAt: z.iso.datetime()
  })
  .strict();
const PhaseKeySchema = z
  .string()
  .regex(
    /^(?:environment:[a-z]+_[0-9a-f-]{36}:(?:authorization|intent|prepared|disposed)|command:[a-z]+_[0-9a-f-]{36}:(?:authorization|intent|started|completed|cancel)|command:[a-z]+_[0-9a-f-]{36}:artifact:art_[0-9a-f-]{36})$/
  );
const PhaseDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const isSafeJsonRecord = (
  value: SafeJsonValue
): value is Readonly<{ [key: string]: SafeJsonValue }> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const phaseDigestInput = (type: string, payload: unknown): Readonly<Record<string, unknown>> => {
  const normalized = normalizeSafeJson(payload);
  if (!isSafeJsonRecord(normalized)) {
    throw new TypeError("A local execution phase payload is required.");
  }
  const phasePayload: Readonly<Record<string, unknown>> = normalized;
  const { phaseDigest: _phaseDigest, ...withoutDigest } = phasePayload;
  return { type, payload: withoutDigest };
};
export const digestLocalExecutionPhase = async (type: string, payload: unknown): Promise<string> =>
  digestVersionedValue("autostack.local-execution-phase", phaseDigestInput(type, payload));
export const digestTerminalRunTransition = async (event: unknown): Promise<string> =>
  digestVersionedValue("autostack.terminal-run-transition", event);

const StageIdentityShape = {
  runId: RunIdSchema,
  stage: RunStageSchema,
  jobId: JobIdSchema
} as const;

const DomainEventBodySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("work_item.created"),
      payload: z.object({ workItem: WorkItemSchema }).strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("run.created"),
      payload: z.object({ run: RunSchema }).strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("run.transitioned"),
      payload: z
        .object({
          runId: RunIdSchema,
          from: RunStatusSchema,
          to: RunStatusSchema,
          reason: z.string().trim().min(1).max(2_000),
          resumeStatus: RunStatusSchema.optional()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("stage.queued"),
      payload: z.object(StageIdentityShape).strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("stage.leased"),
      payload: z
        .object({
          ...StageIdentityShape,
          workerId: z.string().min(1),
          attempt: z.number().int().positive()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("stage.succeeded"),
      payload: z.object(StageIdentityShape).strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("stage.failed"),
      payload: z
        .object({
          ...StageIdentityShape,
          error: WorkflowFailureSchema
        })
        .strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("approval.requested"),
      payload: z.object({ approval: ApprovalSchema }).strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("approval.decided"),
      payload: z
        .object({
          approvalId: ApprovalIdSchema,
          runId: RunIdSchema,
          decision: z.enum(["approved", "rejected"]),
          evidenceDigest: z.string().regex(/^[0-9a-f]{64}$/i),
          origin: z.enum(["desktop", "web", "cli", "slack", "github", "api"]),
          decidedAt: z.iso.datetime()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("environment.authorization_recorded"),
      payload: z
        .object({
          runId: RunIdSchema,
          environmentId: EnvironmentIdSchema,
          authorization: EnvironmentAuthorizationSchema,
          phaseKey: PhaseKeySchema,
          phaseDigest: PhaseDigestSchema
        })
        .strict()
    })
    .strict()
    .superRefine((value, context) => {
      const scope = value.payload.authorization.scope;
      if (
        scope.runId !== value.payload.runId ||
        scope.environmentId !== value.payload.environmentId
      ) {
        context.addIssue({
          code: "custom",
          path: ["payload"],
          message: "Environment authorization identity is invalid."
        });
      }
    }),
  z
    .object({
      type: z.literal("command.authorization_recorded"),
      payload: z
        .object({
          runId: RunIdSchema,
          environmentId: EnvironmentIdSchema,
          commandId: CommandIdSchema,
          authorization: CommandAuthorizationSchema,
          phaseKey: PhaseKeySchema,
          phaseDigest: PhaseDigestSchema
        })
        .strict()
    })
    .strict()
    .superRefine((value, context) => {
      const scope = value.payload.authorization.scope;
      if (
        scope.runId !== value.payload.runId ||
        scope.environmentId !== value.payload.environmentId ||
        scope.commandId !== value.payload.commandId
      ) {
        context.addIssue({
          code: "custom",
          path: ["payload"],
          message: "Command authorization identity is invalid."
        });
      }
    }),
  z
    .object({
      type: z.literal("environment.prepare_requested"),
      payload: z
        .object({
          request: PrepareEnvironmentRequestSchema,
          phaseKey: PhaseKeySchema,
          phaseDigest: PhaseDigestSchema
        })
        .strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("environment.prepared"),
      payload: z
        .object({
          environment: PreparedEnvironmentSchema,
          phaseKey: PhaseKeySchema,
          phaseDigest: PhaseDigestSchema
        })
        .strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("command.intent_recorded"),
      payload: z
        .object({
          request: StartCommandRequestSchema,
          phaseKey: PhaseKeySchema,
          phaseDigest: PhaseDigestSchema
        })
        .strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("command.started"),
      payload: z
        .object({
          runId: RunIdSchema,
          environmentId: EnvironmentIdSchema,
          commandId: CommandIdSchema,
          startedAt: z.iso.datetime(),
          phaseKey: PhaseKeySchema,
          phaseDigest: PhaseDigestSchema
        })
        .strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("command.completed"),
      payload: z
        .object({
          runId: RunIdSchema,
          environmentId: EnvironmentIdSchema,
          commandId: CommandIdSchema,
          terminalSequence: z.number().int().positive(),
          terminalDigest: z.string().regex(/^[0-9a-f]{64}$/),
          status: z.enum(["completed", "cancelled", "failed"]),
          completedAt: z.iso.datetime(),
          phaseKey: PhaseKeySchema,
          phaseDigest: PhaseDigestSchema
        })
        .strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("artifact.recorded"),
      payload: z
        .object({
          runId: RunIdSchema,
          environmentId: EnvironmentIdSchema,
          commandId: CommandIdSchema,
          artifact: ArtifactDescriptorSchema,
          phaseKey: PhaseKeySchema,
          phaseDigest: PhaseDigestSchema
        })
        .strict()
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.payload.artifact.runId !== value.payload.runId ||
        value.payload.artifact.commandId !== value.payload.commandId
      ) {
        context.addIssue({
          code: "custom",
          path: ["payload", "artifact"],
          message: "Artifact identity is invalid."
        });
      }
    }),
  z
    .object({
      type: z.literal("environment.disposed"),
      payload: z
        .object({
          runId: RunIdSchema,
          environmentId: EnvironmentIdSchema,
          environmentAuthorizationId: EnvironmentAuthorizationIdSchema,
          environmentAuthorizationDigest: z.string().regex(/^[0-9a-f]{64}$/),
          terminalRunEvidence: TerminalRunEvidenceSchema,
          disposedAt: z.iso.datetime(),
          phaseKey: PhaseKeySchema,
          phaseDigest: PhaseDigestSchema
        })
        .strict()
    })
    .strict()
]);

const StoredEventMetadataSchema = z.object({
  eventId: EventIdSchema,
  stream: z
    .object({
      kind: z.enum(["workspace", "project", "work_item", "run", "automation"]),
      id: z.string().min(1)
    })
    .strict(),
  streamVersion: z.number().int().positive(),
  globalSequence: z.number().int().positive(),
  schemaVersion: z.literal(1)
});

export const PendingDomainEventSchema = EventContextSchema.and(DomainEventBodySchema).superRefine(
  (event, context) => {
    const mismatchedWorkspace = (workspaceId: string) => {
      if (event.workspaceId !== workspaceId) {
        context.addIssue({
          code: "custom",
          path: ["workspaceId"],
          message: "Event workspace does not match local execution evidence."
        });
      }
    };
    switch (event.type) {
      case "environment.authorization_recorded":
        mismatchedWorkspace(event.payload.authorization.scope.workspaceId);
        break;
      case "command.authorization_recorded":
        mismatchedWorkspace(event.payload.authorization.scope.workspaceId);
        break;
      case "environment.prepare_requested":
        mismatchedWorkspace(event.payload.request.workspaceId);
        break;
      case "environment.prepared":
        mismatchedWorkspace(event.payload.environment.workspaceId);
        break;
      case "command.intent_recorded":
        mismatchedWorkspace(event.payload.request.workspaceId);
        break;
      case "artifact.recorded":
        mismatchedWorkspace(event.payload.artifact.workspaceId);
        break;
      default:
        break;
    }
  }
);
export type PendingDomainEvent = z.infer<typeof PendingDomainEventSchema>;

const localPhase = (
  event: PendingDomainEvent
): { readonly key: string; readonly digest: string } | undefined => {
  switch (event.type) {
    case "environment.authorization_recorded":
    case "command.authorization_recorded":
    case "environment.prepare_requested":
    case "environment.prepared":
    case "command.intent_recorded":
    case "command.started":
    case "command.completed":
    case "artifact.recorded":
    case "environment.disposed":
      return { key: event.payload.phaseKey, digest: event.payload.phaseDigest };
    default:
      return undefined;
  }
};
const canonicalizeLocalPhaseReplayContext = (event: PendingDomainEvent): string =>
  canonicalizeVersionedDigestValue("autostack.local-execution-phase-replay-context", {
    type: event.type,
    workspaceId: event.workspaceId,
    actor: event.actor,
    occurredAt: event.occurredAt
  });
const assertPhaseKey = (actual: string, expected: string): void => {
  if (actual !== expected) throw new TypeError("Local execution phase key is invalid.");
};

export const validateRunStreamCoherence = async (
  candidates: readonly unknown[]
): Promise<readonly (PendingDomainEvent | StoredDomainEvent)[]> => {
  const events = candidates.map((candidate) => {
    const normalized = normalizeSafeJson(candidate);
    if (isSafeJsonRecord(normalized) && Object.hasOwn(normalized, "globalSequence")) {
      return StoredDomainEventSchema.parse(normalized);
    }
    return PendingDomainEventSchema.parse(normalized);
  });
  const environmentAuthorizations = new Map<string, EnvironmentAuthorization>();
  const commandAuthorizations = new Map<string, CommandAuthorization>();
  const artifactDescriptors = new Map<string, string>();
  const environments = new Map<
    string,
    {
      authorization: EnvironmentAuthorization;
      prepareRequest?: PrepareEnvironmentRequest;
      prepared?: PreparedEnvironment;
      disposed: boolean;
    }
  >();
  const commands = new Map<
    string,
    {
      authorization: CommandAuthorization;
      intent?: StartCommandRequest;
      started: boolean;
      completed: boolean;
      hasArtifact: boolean;
    }
  >();
  const approvals = new Map<
    string,
    {
      readonly approval: z.infer<typeof ApprovalSchema>;
      readonly approved: boolean;
      readonly decided: boolean;
    }
  >();
  const terminalRuns = new Map<string, TerminalRunEvidence>();
  const phaseDigests = new Map<string, { readonly digest: string; readonly context: string }>();
  const assertAuthorizationIsActiveAt = (
    authorization: EnvironmentAuthorization | CommandAuthorization,
    occurredAt: string,
    label: string
  ): void => {
    const createdAt = Date.parse(authorization.createdAt);
    const expiresAt = Date.parse(authorization.expiresAt);
    const at = Date.parse(occurredAt);
    if (Number.isNaN(createdAt) || Number.isNaN(expiresAt) || Number.isNaN(at)) {
      throw new TypeError(`${label} timestamps are invalid.`);
    }
    if (createdAt > at || at >= expiresAt) {
      throw new TypeError(`${label} is not active at the event timestamp.`);
    }
  };
  const assertRunCanExecute = (workspaceId: string, runId: string): void => {
    if (terminalRuns.has(`${workspaceId}:${runId}`)) {
      throw new TypeError("Execution evidence cannot follow a terminal run transition.");
    }
  };
  const assertEnvironmentIsActive = (environmentId: string): void => {
    if (environments.get(environmentId)?.disposed) {
      throw new TypeError("Execution evidence cannot follow environment disposal.");
    }
  };
  const admissionDependencies = {
    resolveApproval: async (approvalId: z.infer<typeof ApprovalIdSchema>) =>
      approvals.get(approvalId)?.approval,
    resolveEnvironmentAuthorization: async (
      authorizationId: z.infer<typeof EnvironmentAuthorizationIdSchema>
    ) => environmentAuthorizations.get(authorizationId),
    resolveCommandAuthorization: async (
      authorizationId: z.infer<typeof CommandAuthorizationSchema>["id"]
    ) => commandAuthorizations.get(authorizationId)
  };
  for (const event of events) {
    const phase = localPhase(event);
    if (phase !== undefined) {
      const actualDigest = await digestLocalExecutionPhase(event.type, event.payload);
      const providedDigest = phase.digest;
      if (providedDigest !== actualDigest)
        throw new TypeError("Local execution phase digest is invalid.");
      const replayContext = canonicalizeLocalPhaseReplayContext(event);
      const previous = phaseDigests.get(phase.key);
      if (previous !== undefined) {
        if (previous.digest !== providedDigest) {
          throw new TypeError("Local execution phase key collision.");
        }
        if (previous.context !== replayContext) {
          throw new TypeError("Local execution phase replay context is immutable.");
        }
        continue;
      }
      phaseDigests.set(phase.key, { digest: providedDigest, context: replayContext });
    }
    switch (event.type) {
      case "run.transitioned": {
        if (
          event.payload.to === "completed" ||
          event.payload.to === "cancelled" ||
          event.payload.to === "failed"
        ) {
          if (!("globalSequence" in event) || !("eventId" in event)) {
            throw new TypeError("Terminal run transition requires sequenced durable evidence.");
          }
          const key = `${event.workspaceId}:${event.payload.runId}`;
          if (terminalRuns.has(key))
            throw new TypeError("Run has more than one terminal transition.");
          const terminalMetadata = StoredEventMetadataSchema.parse(event);
          terminalRuns.set(key, {
            status: event.payload.to,
            terminalEventSequence: terminalMetadata.globalSequence,
            terminalEventDigest: await digestTerminalRunTransition(event)
          });
        }
        break;
      }
      case "approval.requested": {
        const approval = event.payload.approval;
        if (
          approval.workspaceId !== event.workspaceId ||
          isNaN(Date.parse(approval.createdAt)) ||
          Date.parse(approval.createdAt) > Date.parse(event.occurredAt) ||
          approvals.has(approval.id)
        ) {
          throw new TypeError("Approval request evidence is invalid.");
        }
        approvals.set(approval.id, { approval, approved: false, decided: false });
        break;
      }
      case "approval.decided": {
        const recorded = approvals.get(event.payload.approvalId);
        if (recorded !== undefined && recorded.approval.workspaceId !== event.workspaceId) {
          throw new TypeError("Approval decision workspace does not match its recorded approval.");
        }
        if (
          recorded === undefined ||
          recorded.decided ||
          recorded.approval.workspaceId !== event.workspaceId ||
          recorded.approval.runId !== event.payload.runId ||
          recorded.approval.evidenceDigest !== event.payload.evidenceDigest ||
          recorded.approval.status !== "pending"
        ) {
          throw new TypeError("Approval decision lacks matching request evidence.");
        }
        if (!recorded.approval.eligibleApproverIds.includes(event.actor.id)) {
          throw new TypeError("Approval decision actor is not eligible.");
        }
        const createdAt = Date.parse(recorded.approval.createdAt);
        const decidedAt = Date.parse(event.payload.decidedAt);
        const occurredAt = Date.parse(event.occurredAt);
        if (
          Number.isNaN(createdAt) ||
          Number.isNaN(decidedAt) ||
          Number.isNaN(occurredAt) ||
          decidedAt < createdAt ||
          decidedAt !== occurredAt
        ) {
          throw new TypeError("Approval decision timestamp is incoherent.");
        }
        const approval = ApprovalSchema.parse({
          ...recorded.approval,
          status: event.payload.decision,
          decision: {
            decision: event.payload.decision,
            actor: event.actor,
            origin: event.payload.origin,
            decidedAt: event.payload.decidedAt
          },
          updatedAt: event.payload.decidedAt
        });
        approvals.set(event.payload.approvalId, {
          approval,
          approved: event.payload.decision === "approved",
          decided: true
        });
        break;
      }
      case "environment.authorization_recorded": {
        const { authorization, environmentId } = event.payload;
        assertPhaseKey(event.payload.phaseKey, `environment:${environmentId}:authorization`);
        assertRunCanExecute(event.workspaceId, event.payload.runId);
        assertEnvironmentIsActive(environmentId);
        assertAuthorizationIsActiveAt(authorization, event.occurredAt, "Environment authorization");
        if (
          authorization.digest !== (await digestEnvironmentAuthorization(authorization)) ||
          authorization.approvalEvidenceDigest !== (await digestExecutionScope(authorization.scope))
        ) {
          throw new TypeError("Environment authorization digest is invalid.");
        }
        const approval = approvals.get(authorization.approvalId);
        if (
          approval === undefined ||
          !approval.approved ||
          approval.approval.kind !== "plan" ||
          approval.approval.workspaceId !== authorization.scope.workspaceId ||
          approval.approval.runId !== authorization.scope.runId ||
          approval.approval.evidenceDigest !== authorization.approvalEvidenceDigest
        ) {
          throw new TypeError("Environment authorization lacks approved plan evidence.");
        }
        const existing = environments.get(environmentId);
        if (existing !== undefined) {
          throw new TypeError("Environment authorization is already recorded.");
        }
        if (environmentAuthorizations.has(authorization.id)) {
          throw new TypeError("Environment authorization IDs are immutable.");
        }
        environmentAuthorizations.set(authorization.id, authorization);
        environments.set(environmentId, { authorization, disposed: false });
        break;
      }
      case "command.authorization_recorded": {
        const { authorization, environmentId, commandId } = event.payload;
        assertPhaseKey(event.payload.phaseKey, `command:${commandId}:authorization`);
        assertRunCanExecute(event.workspaceId, event.payload.runId);
        assertEnvironmentIsActive(environmentId);
        assertAuthorizationIsActiveAt(authorization, event.occurredAt, "Command authorization");
        const environment = environments.get(environmentId);
        const environmentAuthorization = environment?.authorization;
        if (environmentAuthorization === undefined)
          throw new TypeError("Command authorization lacks environment authorization.");
        if (
          authorization.digest !== (await digestCommandAuthorization(authorization)) ||
          authorization.approvalEvidenceDigest !==
            (await digestCommandScope(authorization.scope)) ||
          authorization.scope.environmentAuthorizationId !== environmentAuthorization.id ||
          authorization.scope.environmentAuthorizationDigest !== environmentAuthorization.digest
        ) {
          throw new TypeError("Command authorization digest is invalid.");
        }
        validateCommandAuthorizationAgainstEnvironment(authorization, environmentAuthorization);
        const approval = approvals.get(authorization.approvalId);
        if (
          approval === undefined ||
          !approval.approved ||
          approval.approval.kind !== "permission" ||
          approval.approval.workspaceId !== authorization.scope.workspaceId ||
          approval.approval.runId !== authorization.scope.runId ||
          approval.approval.evidenceDigest !== authorization.approvalEvidenceDigest
        ) {
          throw new TypeError("Command authorization lacks approved permission evidence.");
        }
        if (commands.has(commandId))
          throw new TypeError("Command authorization is already recorded.");
        if (commandAuthorizations.has(authorization.id)) {
          throw new TypeError("Command authorization IDs are immutable.");
        }
        commandAuthorizations.set(authorization.id, authorization);
        commands.set(commandId, {
          authorization,
          started: false,
          completed: false,
          hasArtifact: false
        });
        break;
      }
      case "environment.prepare_requested": {
        const { request, phaseKey } = event.payload;
        assertPhaseKey(phaseKey, `environment:${request.environmentId}:intent`);
        assertRunCanExecute(event.workspaceId, request.runId);
        assertEnvironmentIsActive(request.environmentId);
        const environment = environments.get(request.environmentId);
        if (environment === undefined) {
          throw new TypeError("Environment prepare lacks recorded authorization.");
        }
        const authorization = environment.authorization;
        if (
          authorization === undefined ||
          authorization.id !== request.authorization.id ||
          authorization.digest !== request.authorization.digest ||
          canonicalizeEnvironmentAuthorizationForDigest(authorization) !==
            canonicalizeEnvironmentAuthorizationForDigest(request.authorization)
        ) {
          throw new TypeError("Environment prepare lacks recorded authorization.");
        }
        await admitPrepareEnvironment(request, event.occurredAt, admissionDependencies);
        if (environment.prepareRequest !== undefined) {
          throw new TypeError("Environment already has a durable prepare intent.");
        }
        environments.set(request.environmentId, { ...environment, prepareRequest: request });
        break;
      }
      case "environment.prepared": {
        const { environment, phaseKey } = event.payload;
        assertPhaseKey(phaseKey, `environment:${environment.environmentId}:prepared`);
        assertRunCanExecute(event.workspaceId, environment.runId);
        assertEnvironmentIsActive(environment.environmentId);
        const recorded = environments.get(environment.environmentId);
        const request = recorded?.prepareRequest;
        if (
          recorded === undefined ||
          request === undefined ||
          environment.workspaceId !== request.workspaceId ||
          environment.runId !== request.runId ||
          environment.repositoryIdentity !== request.inspection.repositoryIdentity ||
          environment.sourceCommit !== request.sourceCommit ||
          environment.branch !== request.branch ||
          canonicalizeEnvironmentAuthorizationForDigest(environment.authorization) !==
            canonicalizeEnvironmentAuthorizationForDigest(recorded.authorization) ||
          canonicalizeEnvironmentAuthorizationForDigest(environment.authorization) !==
            canonicalizeEnvironmentAuthorizationForDigest(request.authorization)
        ) {
          throw new TypeError("Prepared environment lacks durable prepare intent.");
        }
        environments.set(environment.environmentId, { ...recorded, prepared: environment });
        break;
      }
      case "command.intent_recorded": {
        const { request, phaseKey } = event.payload;
        assertPhaseKey(phaseKey, `command:${request.commandId}:intent`);
        assertRunCanExecute(event.workspaceId, request.runId);
        assertEnvironmentIsActive(request.environmentId);
        const environment = environments.get(request.environmentId);
        const command = commands.get(request.commandId);
        if (environment?.prepared === undefined || command === undefined) {
          throw new TypeError(
            "Command intent lacks recorded authorization or environment preparation."
          );
        }
        const authorization = command.authorization;
        if (
          authorization === undefined ||
          authorization.id !== request.authorization.id ||
          authorization.digest !== request.authorization.digest ||
          canonicalizeCommandAuthorizationForDigest(authorization) !==
            canonicalizeCommandAuthorizationForDigest(request.authorization)
        ) {
          throw new TypeError(
            "Command intent lacks recorded authorization or environment preparation."
          );
        }
        await admitStartCommand(request, event.occurredAt, admissionDependencies);
        if (command.intent !== undefined)
          throw new TypeError("Command already has a durable intent.");
        commands.set(request.commandId, { ...command, intent: request });
        break;
      }
      case "command.started": {
        assertPhaseKey(event.payload.phaseKey, `command:${event.payload.commandId}:started`);
        assertRunCanExecute(event.workspaceId, event.payload.runId);
        assertEnvironmentIsActive(event.payload.environmentId);
        const command = commands.get(event.payload.commandId);
        if (
          command?.intent === undefined ||
          command.intent.workspaceId !== event.workspaceId ||
          command.intent.runId !== event.payload.runId ||
          command.intent.environmentId !== event.payload.environmentId ||
          command.started
        ) {
          throw new TypeError("Command started before durable intent.");
        }
        commands.set(event.payload.commandId, { ...command, started: true });
        break;
      }
      case "artifact.recorded": {
        assertPhaseKey(
          event.payload.phaseKey,
          `command:${event.payload.commandId}:artifact:${event.payload.artifact.artifactId}`
        );
        assertRunCanExecute(event.workspaceId, event.payload.runId);
        assertEnvironmentIsActive(event.payload.environmentId);
        const command = commands.get(event.payload.commandId);
        if (
          command?.intent === undefined ||
          !command.started ||
          command.completed ||
          command.intent.workspaceId !== event.workspaceId ||
          command.intent.runId !== event.payload.runId ||
          command.intent.environmentId !== event.payload.environmentId ||
          event.payload.artifact.workspaceId !== event.workspaceId ||
          event.payload.artifact.runId !== event.payload.runId ||
          event.payload.artifact.commandId !== event.payload.commandId
        ) {
          throw new TypeError("Artifact recorded before command start.");
        }
        const descriptorDigest = await digestVersionedValue(
          "autostack.artifact-descriptor",
          event.payload.artifact
        );
        const priorDescriptorDigest = artifactDescriptors.get(event.payload.artifact.artifactId);
        if (priorDescriptorDigest !== undefined && priorDescriptorDigest !== descriptorDigest) {
          throw new TypeError("Artifact ID is immutable to its canonical owner and descriptor.");
        }
        artifactDescriptors.set(event.payload.artifact.artifactId, descriptorDigest);
        commands.set(event.payload.commandId, { ...command, hasArtifact: true });
        break;
      }
      case "command.completed": {
        assertPhaseKey(event.payload.phaseKey, `command:${event.payload.commandId}:completed`);
        assertRunCanExecute(event.workspaceId, event.payload.runId);
        assertEnvironmentIsActive(event.payload.environmentId);
        const command = commands.get(event.payload.commandId);
        if (
          command?.intent === undefined ||
          command.intent.workspaceId !== event.workspaceId ||
          command.intent.runId !== event.payload.runId ||
          command.intent.environmentId !== event.payload.environmentId
        ) {
          throw new TypeError("Command completion lacks durable intent.");
        }
        if (!command.hasArtifact) {
          throw new TypeError("Command completion lacks artifact evidence.");
        }
        if (command.completed) {
          throw new TypeError("Command has more than one terminal result.");
        }
        commands.set(event.payload.commandId, { ...command, completed: true });
        break;
      }
      case "environment.disposed": {
        assertPhaseKey(
          event.payload.phaseKey,
          `environment:${event.payload.environmentId}:disposed`
        );
        const evidence = terminalRuns.get(`${event.workspaceId}:${event.payload.runId}`);
        const environment = environments.get(event.payload.environmentId);
        const hasActiveCommand = Array.from(commands.values()).some(
          (command) =>
            command.authorization.scope.environmentId === event.payload.environmentId &&
            command.started &&
            !command.completed
        );
        if (
          environment === undefined ||
          environment.disposed ||
          environment.prepared === undefined ||
          environment.prepared.workspaceId !== event.workspaceId ||
          environment.prepared.runId !== event.payload.runId ||
          evidence === undefined ||
          evidence.status !== event.payload.terminalRunEvidence.status ||
          evidence.terminalEventSequence !==
            event.payload.terminalRunEvidence.terminalEventSequence ||
          evidence.terminalEventDigest !== event.payload.terminalRunEvidence.terminalEventDigest ||
          hasActiveCommand ||
          environment.authorization.id !== event.payload.environmentAuthorizationId ||
          environment.authorization.digest !== event.payload.environmentAuthorizationDigest
        ) {
          throw new TypeError(
            "Environment disposal lacks terminal evidence or authorization binding."
          );
        }
        environments.set(event.payload.environmentId, { ...environment, disposed: true });
        break;
      }
      default:
        break;
    }
  }
  return events;
};

export const domainEventIdentity = (event: PendingDomainEvent) => {
  switch (event.type) {
    case "work_item.created":
      return {
        kind: "work_item" as const,
        id: event.payload.workItem.id,
        workspaceId: event.payload.workItem.workspaceId
      };
    case "run.created":
      return {
        kind: "run" as const,
        id: event.payload.run.id,
        workspaceId: event.payload.run.workspaceId
      };
    case "approval.requested":
      return {
        kind: "run" as const,
        id: event.payload.approval.runId,
        workspaceId: event.payload.approval.workspaceId
      };
    case "environment.prepared":
      return {
        kind: "run" as const,
        id: event.payload.environment.runId,
        workspaceId: event.payload.environment.workspaceId
      };
    case "environment.prepare_requested":
      return {
        kind: "run" as const,
        id: event.payload.request.runId,
        workspaceId: event.payload.request.workspaceId
      };
    case "command.intent_recorded":
      return {
        kind: "run" as const,
        id: event.payload.request.runId,
        workspaceId: event.payload.request.workspaceId
      };
    default:
      return { kind: "run" as const, id: event.payload.runId, workspaceId: event.workspaceId };
  }
};

export const StoredDomainEventSchema = PendingDomainEventSchema.and(
  StoredEventMetadataSchema
).superRefine((event, context) => {
  const identity = domainEventIdentity(event);
  if (event.stream.kind !== identity.kind || event.stream.id !== identity.id) {
    context.addIssue({
      code: "custom",
      path: ["stream"],
      message: "Event stream identity is invalid."
    });
  }
  if (event.workspaceId !== identity.workspaceId) {
    context.addIssue({
      code: "custom",
      path: ["workspaceId"],
      message: "Event workspace is invalid."
    });
  }
});

export type StoredDomainEvent = z.infer<typeof StoredDomainEventSchema>;
export type DomainEventType = (typeof EVENT_TYPES)[number];

export const parseStoredDomainEvent = (candidate: unknown): StoredDomainEvent => {
  const normalized = normalizeSafeJson(candidate);
  if (!isSafeJsonRecord(normalized)) {
    return StoredDomainEventSchema.parse(normalized);
  }
  const event = normalized;
  if (event.schemaVersion !== 1 || event.type !== "stage.failed") {
    return StoredDomainEventSchema.parse(normalized);
  }
  const payload = event.payload;
  if (payload === undefined || !isSafeJsonRecord(payload)) {
    return StoredDomainEventSchema.parse(normalized);
  }
  const error = payload.error;
  if (error === undefined || !isSafeJsonRecord(error) || Object.hasOwn(error, "code")) {
    return StoredDomainEventSchema.parse(normalized);
  }
  return StoredDomainEventSchema.parse({
    ...event,
    payload: {
      ...payload,
      error: { ...error, code: "legacy_workflow_failure" }
    }
  });
};
