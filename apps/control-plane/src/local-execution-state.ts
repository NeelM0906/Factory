import { createHash } from "node:crypto";

import {
  ApprovalSchema,
  ArtifactIdSchema,
  CancelCommandRequestSchema,
  DisposeEnvironmentRequestSchema,
  PendingDomainEventSchema,
  PrepareEnvironmentRequestSchema,
  ReadArtifactChunkRequestSchema,
  ReadCommandEventsRequestSchema,
  StartCommandRequestSchema,
  digestLocalExecutionPhase,
  digestTerminalRunTransition,
  digestVersionedValue,
  validateRunStreamCoherence,
  type Approval,
  type ApprovalId,
  type ArtifactDescriptor,
  type ArtifactId,
  type CancelCommandRequest,
  type CommandAuthorization,
  type CommandId,
  type DisposeEnvironmentRequest,
  type EnvironmentAuthorization,
  type HostResponseBodyByRoute,
  type LocalArtifactReadRequest,
  type LocalCancelRequest,
  type LocalDisposeRequest,
  type LocalEventsRequest,
  type LocalPrepareRequest,
  type LocalStartRequest,
  type PendingDomainEvent,
  type PrepareEnvironmentRequest,
  type ReadArtifactChunkRequest,
  type ReadCommandEventsRequest,
  type RepositoryInspection,
  type Run,
  type RunnerStreamEvent,
  type StartCommandRequest,
  type StoredDomainEvent,
  type WorkspaceId
} from "@autostack/contracts";
import {
  canonicalJson,
  decideCommandStart,
  decideEnvironmentPreparation,
  transitionRun,
  type DurableStore,
  type ExecutionPolicyAuthority
} from "@autostack/domain";

import type { CommandEvidenceSink } from "./command-reconciler.js";
import type { LocalExecutionState } from "./local-execution-service.js";
import { deriveDurableCommandCursor } from "./reconciliation-cursor.js";

const ACTOR = { kind: "system" as const, id: "local-execution-reconciler" };
const ZERO_DIGEST = "0".repeat(64);

interface RunSnapshot {
  readonly events: readonly StoredDomainEvent[];
  readonly run: Run;
  readonly approvals: ReadonlyMap<string, Approval>;
  readonly environmentAuthorizations: ReadonlyMap<string, EnvironmentAuthorization>;
  readonly commandAuthorizations: ReadonlyMap<string, CommandAuthorization>;
}

const stableUuid = (value: string): string => {
  const bytes = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  bytes[12] = "4";
  bytes[16] = "8";
  const hex = bytes.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const projectRun = (events: readonly StoredDomainEvent[]): Run => {
  const created = events.find((event) => event.type === "run.created");
  if (created?.type !== "run.created") throw new TypeError("Run evidence is missing.");
  let run = created.payload.run;
  for (const event of events) {
    if (event.type !== "run.transitioned") continue;
    run = transitionRun({
      run,
      to: event.payload.to,
      reason: event.payload.reason,
      ...(event.payload.resumeStatus === undefined
        ? {}
        : { resumeStatus: event.payload.resumeStatus }),
      actor: event.actor,
      correlationId: event.correlationId,
      occurredAt: event.occurredAt
    }).run;
  }
  return run;
};

const projectApprovals = (events: readonly StoredDomainEvent[]): Map<string, Approval> => {
  const approvals = new Map<string, Approval>();
  for (const event of events) {
    if (event.type === "approval.requested")
      approvals.set(event.payload.approval.id, event.payload.approval);
    if (event.type !== "approval.decided") continue;
    const approval = approvals.get(event.payload.approvalId);
    if (approval === undefined) throw new TypeError("Approval decision evidence is incomplete.");
    approvals.set(
      approval.id,
      ApprovalSchema.parse({
        ...approval,
        status: event.payload.decision,
        decision: {
          decision: event.payload.decision,
          actor: event.actor,
          origin: event.payload.origin,
          decidedAt: event.payload.decidedAt
        },
        updatedAt: event.payload.decidedAt
      })
    );
  }
  return approvals;
};

export interface EventBackedLocalExecutionStateOptions {
  readonly store: DurableStore;
  readonly workspaceId: WorkspaceId;
  readonly now: () => string;
}

export class EventBackedLocalExecutionState implements LocalExecutionState, CommandEvidenceSink {
  readonly #options: EventBackedLocalExecutionStateOptions;

  constructor(options: EventBackedLocalExecutionStateOptions) {
    this.#options = options;
  }

  async #loadRun(runId: Run["id"]): Promise<RunSnapshot> {
    const events: StoredDomainEvent[] = [];
    let after = 0;
    while (events.length < 10_000) {
      const page = await this.#options.store.readRunEvents({
        workspaceId: this.#options.workspaceId,
        runId,
        afterGlobalSequence: after,
        limit: 100
      });
      events.push(...page);
      if (page.length < 100) break;
      after = page.at(-1)?.globalSequence ?? after;
    }
    await validateRunStreamCoherence(events);
    const environmentAuthorizations = new Map<string, EnvironmentAuthorization>();
    const commandAuthorizations = new Map<string, CommandAuthorization>();
    for (const event of events) {
      if (event.type === "environment.authorization_recorded")
        environmentAuthorizations.set(event.payload.authorization.id, event.payload.authorization);
      if (event.type === "command.authorization_recorded")
        commandAuthorizations.set(event.payload.authorization.id, event.payload.authorization);
    }
    return {
      events,
      run: projectRun(events),
      approvals: projectApprovals(events),
      environmentAuthorizations,
      commandAuthorizations
    };
  }

  #authority(snapshot: RunSnapshot): ExecutionPolicyAuthority {
    return {
      resolveRun: async (runId) => (runId === snapshot.run.id ? snapshot.run : undefined),
      resolveApproval: async (approvalId) => snapshot.approvals.get(approvalId),
      resolveEnvironmentAuthorization: async (authorizationId) =>
        snapshot.environmentAuthorizations.get(authorizationId),
      resolveCommandAuthorization: async (authorizationId) =>
        snapshot.commandAuthorizations.get(authorizationId),
      resolveArtifact: async (artifactId) => {
        const event = snapshot.events.find(
          (event) =>
            event.type === "artifact.recorded" && event.payload.artifact.artifactId === artifactId
        );
        return event?.type === "artifact.recorded" ? event.payload.artifact : undefined;
      },
      resolveTerminalRunEvidence: async () => this.#terminalEvidence(snapshot),
      hasActiveCommands: async ({ environmentId }) => {
        const started = new Set(
          snapshot.events.flatMap((event) =>
            event.type === "command.started" && event.payload.environmentId === environmentId
              ? [event.payload.commandId]
              : []
          )
        );
        for (const event of snapshot.events)
          if (event.type === "command.completed") started.delete(event.payload.commandId);
        return started.size > 0;
      }
    };
  }

  async authorizePreparation(
    input: LocalPrepareRequest,
    inspection: RepositoryInspection,
    idempotencyKey: string
  ): Promise<PrepareEnvironmentRequest> {
    const snapshot = await this.#loadRun(input.runId);
    const authorization = snapshot.environmentAuthorizations.get(input.environmentAuthorizationId);
    if (
      authorization === undefined ||
      authorization.approvalId !== input.approvalId ||
      authorization.scope.environmentId !== input.environmentId ||
      !authorization.scope.branch.endsWith(`/${input.branchSlug}`)
    )
      throw new TypeError("Environment authorization is invalid.");
    const request = PrepareEnvironmentRequestSchema.parse({
      workspaceId: this.#options.workspaceId,
      runId: input.runId,
      environmentId: input.environmentId,
      inspection,
      sourceCommit: authorization.scope.sourceCommit,
      branch: authorization.scope.branch,
      authorization,
      idempotency: { key: idempotencyKey }
    });
    const decision = await decideEnvironmentPreparation({
      authority: this.#authority(snapshot),
      authenticatedWorkspaceId: this.#options.workspaceId,
      request,
      now: this.#options.now()
    });
    if (!decision.ok) throw new TypeError(`Environment authorization rejected: ${decision.code}`);
    return decision.value;
  }

  async recordPreparationIntent(request: PrepareEnvironmentRequest): Promise<void> {
    const snapshot = await this.#loadRun(request.runId);
    if (!snapshot.environmentAuthorizations.has(request.authorization.id))
      throw new TypeError("Authorization must be durable before intent.");
    await this.#commitPhase(snapshot, "environment.prepare_requested", {
      request,
      phaseKey: `environment:${request.environmentId}:intent`
    });
  }

  async recordPrepared(
    request: PrepareEnvironmentRequest,
    result: HostResponseBodyByRoute["POST /v1/environments"]
  ): Promise<void> {
    const snapshot = await this.#loadRun(request.runId);
    if (snapshot.events.some((event) => event.type === "environment.prepared")) return;
    const occurredAt = this.#options.now();
    const phase = await this.#phase("environment.prepared", {
      environment: result.environment,
      phaseKey: `environment:${request.environmentId}:prepared`
    });
    const transition = transitionRun({
      run: snapshot.run,
      to: "implementing",
      reason: "Local environment prepared.",
      actor: ACTOR,
      correlationId: stableUuid(`prepared:${request.environmentId}`),
      occurredAt
    }).events[0];
    if (transition === undefined) throw new TypeError("Prepared transition is missing.");
    await this.#commit(
      snapshot,
      [this.#event(occurredAt, phase), transition],
      String(phase.payload.phaseKey)
    );
  }

  async authorizeStart(
    input: LocalStartRequest,
    idempotencyKey: string
  ): Promise<StartCommandRequest> {
    const snapshot = await this.#loadRun(input.runId);
    const authorization = snapshot.commandAuthorizations.get(input.commandAuthorizationId);
    if (
      authorization === undefined ||
      authorization.approvalId !== input.approvalId ||
      authorization.scope.environmentId !== input.environmentId ||
      authorization.scope.commandId !== input.commandId
    )
      throw new TypeError("Command authorization is invalid.");
    const environment = snapshot.environmentAuthorizations.get(
      authorization.scope.environmentAuthorizationId
    );
    if (environment === undefined) throw new TypeError("Environment authorization is missing.");
    const request = StartCommandRequestSchema.parse({
      workspaceId: this.#options.workspaceId,
      runId: input.runId,
      environmentId: input.environmentId,
      commandId: input.commandId,
      command: input.command,
      environmentAuthorizationId: environment.id,
      environmentAuthorizationDigest: environment.digest,
      authorization,
      idempotency: { key: idempotencyKey }
    });
    const decision = await decideCommandStart({
      authority: this.#authority(snapshot),
      authenticatedWorkspaceId: this.#options.workspaceId,
      request,
      now: this.#options.now()
    });
    if (!decision.ok) throw new TypeError(`Command authorization rejected: ${decision.code}`);
    return decision.value;
  }

  async recordCommandIntent(request: StartCommandRequest): Promise<void> {
    const snapshot = await this.#loadRun(request.runId);
    if (!snapshot.commandAuthorizations.has(request.authorization.id))
      throw new TypeError("Authorization must be durable before intent.");
    await this.#commitPhase(snapshot, "command.intent_recorded", {
      request,
      phaseKey: `command:${request.commandId}:intent`
    });
  }

  async listPendingPreparations(): Promise<readonly PrepareEnvironmentRequest[]> {
    const pending: PrepareEnvironmentRequest[] = [];
    await this.#visitRuns(async (snapshot) => {
      const prepared = new Set(
        snapshot.events.flatMap((event) =>
          event.type === "environment.prepared" ? [event.payload.environment.environmentId] : []
        )
      );
      for (const event of snapshot.events) {
        if (
          event.type === "environment.prepare_requested" &&
          !prepared.has(event.payload.request.environmentId)
        )
          pending.push(event.payload.request);
      }
    });
    return pending;
  }

  async listPendingCommandStarts(): Promise<readonly StartCommandRequest[]> {
    const pending: StartCommandRequest[] = [];
    await this.#visitRuns(async (snapshot) => {
      const completed = new Set(
        snapshot.events.flatMap((event) =>
          event.type === "command.completed" ? [event.payload.commandId] : []
        )
      );
      for (const event of snapshot.events) {
        if (
          event.type === "command.intent_recorded" &&
          !completed.has(event.payload.request.commandId)
        )
          pending.push(event.payload.request);
      }
    });
    return pending;
  }

  async resolveReconciliationEvents(
    environmentId: LocalEventsRequest["environmentId"],
    commandId: LocalEventsRequest["commandId"]
  ): Promise<ReadCommandEventsRequest> {
    const { snapshot, intent } = await this.#findCommand(environmentId, commandId);
    return this.resolveEvents({
      environmentId,
      commandId,
      after: deriveDurableCommandCursor(snapshot.events, intent.commandId)
    });
  }

  async resolvePreparationApproval(
    runId: LocalPrepareRequest["runId"],
    environmentId: LocalPrepareRequest["environmentId"],
    authorizationId: LocalPrepareRequest["environmentAuthorizationId"]
  ): Promise<ApprovalId> {
    const snapshot = await this.#loadRun(runId);
    const authorization = snapshot.environmentAuthorizations.get(authorizationId);
    if (authorization?.scope.environmentId !== environmentId)
      throw new TypeError("Environment authorization does not own preparation.");
    const approval = snapshot.approvals.get(authorization.approvalId);
    if (approval?.status !== "approved")
      throw new TypeError("Preparation approval is unavailable.");
    return approval.id;
  }

  async resolveCommandApproval(
    runId: LocalStartRequest["runId"],
    environmentId: LocalStartRequest["environmentId"],
    commandId: LocalStartRequest["commandId"],
    authorizationId: LocalStartRequest["commandAuthorizationId"]
  ): Promise<ApprovalId> {
    const snapshot = await this.#loadRun(runId);
    const authorization = snapshot.commandAuthorizations.get(authorizationId);
    if (
      authorization?.scope.environmentId !== environmentId ||
      authorization.scope.commandId !== commandId
    )
      throw new TypeError("Command authorization does not own start.");
    const approval = snapshot.approvals.get(authorization.approvalId);
    if (approval?.status !== "approved") throw new TypeError("Command approval is unavailable.");
    return approval.id;
  }

  async resolveEvents(input: LocalEventsRequest): Promise<ReadCommandEventsRequest> {
    const { intent } = await this.#findCommand(input.environmentId, input.commandId);
    return ReadCommandEventsRequestSchema.parse({
      workspaceId: intent.workspaceId,
      runId: intent.runId,
      environmentId: intent.environmentId,
      commandId: intent.commandId,
      environmentAuthorizationId: intent.environmentAuthorizationId,
      environmentAuthorizationDigest: intent.environmentAuthorizationDigest,
      commandAuthorizationId: intent.authorization.id,
      commandAuthorizationDigest: intent.authorization.digest,
      after: input.after
    });
  }

  async resolveCancellation(input: LocalCancelRequest): Promise<CancelCommandRequest> {
    const { intent } = await this.#findCommand(input.environmentId, input.commandId);
    if (intent.authorization.id !== input.commandAuthorizationId)
      throw new TypeError("Command authorization does not own cancellation.");
    const { after: _after, ...ownership } = await this.resolveEvents({ ...input, after: 0 });
    void _after;
    return CancelCommandRequestSchema.parse({
      ...ownership,
      idempotency: { key: input.idempotencyKey }
    });
  }

  async resolveArtifactRead(input: LocalArtifactReadRequest): Promise<ReadArtifactChunkRequest> {
    const match = await this.#findArtifact(input.artifactId);
    const ownership = await this.resolveEvents({
      environmentId: match.intent.environmentId,
      commandId: match.intent.commandId,
      after: 0
    });
    const { after: _after, ...artifactOwnership } = ownership;
    void _after;
    return ReadArtifactChunkRequestSchema.parse({
      ...artifactOwnership,
      artifactId: input.artifactId,
      offset: input.offset,
      length: input.length
    });
  }

  async resolveDisposal(input: LocalDisposeRequest): Promise<DisposeEnvironmentRequest> {
    const snapshot = await this.#findEnvironment(input.environmentId);
    const authorization = snapshot.environmentAuthorizations.get(input.environmentAuthorizationId);
    if (authorization?.scope.environmentId !== input.environmentId)
      throw new TypeError("Environment authorization does not own disposal.");
    return DisposeEnvironmentRequestSchema.parse({
      workspaceId: this.#options.workspaceId,
      runId: snapshot.run.id,
      environmentId: input.environmentId,
      environmentAuthorizationId: authorization.id,
      environmentAuthorizationDigest: authorization.digest,
      terminalRunEvidence: await this.#terminalEvidence(snapshot),
      idempotency: { key: input.idempotencyKey }
    });
  }

  async recordStarted(
    event: Extract<RunnerStreamEvent, { type: "command.started" }>
  ): Promise<void> {
    const snapshot = await this.#loadRun(event.runId);
    await this.#commitPhase(snapshot, "command.started", {
      runId: event.runId,
      environmentId: this.#commandIntent(snapshot, event.commandId).environmentId,
      commandId: event.commandId,
      hostSequence: event.sequence,
      startedAt: event.occurredAt,
      phaseKey: `command:${event.commandId}:started`
    });
  }

  async recordArtifact(descriptor: ArtifactDescriptor, hostSequence: number): Promise<void> {
    const snapshot = await this.#loadRun(descriptor.runId);
    const intent = this.#commandIntent(snapshot, descriptor.commandId);
    await this.#commitPhase(snapshot, "artifact.recorded", {
      runId: descriptor.runId,
      environmentId: intent.environmentId,
      commandId: descriptor.commandId,
      ...(hostSequence === 0 ? {} : { hostSequence }),
      artifact: descriptor,
      phaseKey: `command:${descriptor.commandId}:artifact:${descriptor.artifactId}`
    });
  }

  async hasArtifact(artifactId: ArtifactId): Promise<boolean> {
    try {
      await this.#findArtifact(artifactId);
      return true;
    } catch {
      return false;
    }
  }

  async hasVerifiedTranscript(commandId: CommandId): Promise<boolean> {
    const found = await this.#findCommandById(commandId);
    return found.snapshot.events.some(
      (event) =>
        event.type === "artifact.recorded" &&
        event.payload.commandId === commandId &&
        event.payload.artifact.kind === "command_transcript"
    );
  }

  async recordCompletion(
    event: Extract<RunnerStreamEvent, { type: "command.completed" | "stream.error" }>
  ): Promise<void> {
    const snapshot = await this.#loadRun(event.runId);
    const intent = this.#commandIntent(snapshot, event.commandId);
    const status =
      event.type === "stream.error"
        ? "failed"
        : event.cancelled
          ? "cancelled"
          : event.exitCode === 0 && !event.interrupted
            ? "completed"
            : "failed";
    await this.#commitPhase(snapshot, "command.completed", {
      runId: event.runId,
      environmentId: intent.environmentId,
      commandId: event.commandId,
      terminalSequence: event.sequence,
      terminalDigest: await digestVersionedValue("autostack.runner-terminal-event", event),
      status,
      completedAt: event.occurredAt,
      phaseKey: `command:${event.commandId}:completed`
    });
  }

  async #findCommand(environmentId: string, commandId: string) {
    const found = await this.#findCommandById(commandId);
    if (found.intent.environmentId !== environmentId)
      throw new TypeError("Command ownership differs.");
    return found;
  }

  async #findCommandById(commandId: string) {
    return this.#findRun(async (snapshot) => {
      const event = snapshot.events.find(
        (candidate) =>
          candidate.type === "command.intent_recorded" &&
          candidate.payload.request.commandId === commandId
      );
      return event?.type === "command.intent_recorded"
        ? { snapshot, intent: event.payload.request }
        : undefined;
    });
  }

  #commandIntent(snapshot: RunSnapshot, commandId: string): StartCommandRequest {
    const event = snapshot.events.find(
      (candidate) =>
        candidate.type === "command.intent_recorded" &&
        candidate.payload.request.commandId === commandId
    );
    if (event?.type !== "command.intent_recorded")
      throw new TypeError("Command intent is missing.");
    return event.payload.request;
  }

  async #findArtifact(artifactIdCandidate: string) {
    const artifactId = ArtifactIdSchema.parse(artifactIdCandidate);
    return this.#findRun(async (snapshot) => {
      const event = snapshot.events.find(
        (candidate) =>
          candidate.type === "artifact.recorded" &&
          candidate.payload.artifact.artifactId === artifactId
      );
      if (event?.type !== "artifact.recorded") return undefined;
      return {
        snapshot,
        artifact: event.payload.artifact,
        intent: this.#commandIntent(snapshot, event.payload.commandId)
      };
    });
  }

  async #findEnvironment(environmentId: string): Promise<RunSnapshot> {
    return this.#findRun(async (snapshot) =>
      snapshot.events.some(
        (event) =>
          event.type === "environment.prepared" &&
          event.payload.environment.environmentId === environmentId
      )
        ? snapshot
        : undefined
    );
  }

  async #findRun<Value>(
    select: (snapshot: RunSnapshot) => Promise<Value | undefined>
  ): Promise<Value> {
    let cursor: number | undefined;
    do {
      const page = await this.#options.store.listRunSummaries({
        workspaceId: this.#options.workspaceId,
        limit: 100,
        ...(cursor === undefined ? {} : { beforeGlobalSequence: cursor })
      });
      for (const summary of page.items) {
        const value = await select(await this.#loadRun(summary.runId));
        if (value !== undefined) return value;
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    throw new TypeError("Local execution resource was not found.");
  }

  async #visitRuns(visit: (snapshot: RunSnapshot) => Promise<void>): Promise<void> {
    let cursor: number | undefined;
    do {
      const page = await this.#options.store.listRunSummaries({
        workspaceId: this.#options.workspaceId,
        limit: 100,
        ...(cursor === undefined ? {} : { beforeGlobalSequence: cursor })
      });
      for (const summary of page.items) await visit(await this.#loadRun(summary.runId));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }

  async #terminalEvidence(snapshot: RunSnapshot) {
    const event = [...snapshot.events]
      .reverse()
      .find(
        (candidate) =>
          candidate.type === "run.transitioned" &&
          new Set(["completed", "cancelled", "failed"]).has(candidate.payload.to)
      );
    if (event?.type !== "run.transitioned")
      throw new TypeError("Terminal run evidence is missing.");
    return {
      status: event.payload.to as "completed" | "cancelled" | "failed",
      terminalEventSequence: event.globalSequence,
      terminalEventDigest: await digestTerminalRunTransition(event)
    };
  }

  async #commitPhase(
    snapshot: RunSnapshot,
    type: PendingDomainEvent["type"],
    payload: Record<string, unknown>
  ): Promise<void> {
    const phase = await this.#phase(type, payload);
    const phaseKey = (phase.payload as { phaseKey: string }).phaseKey;
    const existing = snapshot.events.find(
      (event) => "phaseKey" in event.payload && event.payload.phaseKey === phaseKey
    );
    if (existing !== undefined) {
      if (
        existing.type !== type ||
        canonicalJson(existing.payload) !== canonicalJson(phase.payload)
      )
        throw new TypeError("Local phase idempotency conflict.");
      return;
    }
    await this.#commit(snapshot, [this.#event(this.#options.now(), phase)], phaseKey);
  }

  async #phase(
    type: PendingDomainEvent["type"],
    payload: Record<string, unknown>
  ): Promise<{ readonly type: string; readonly payload: Record<string, unknown> }> {
    const phaseDigest = await digestLocalExecutionPhase(type, {
      ...payload,
      phaseDigest: ZERO_DIGEST
    });
    return { type, payload: { ...payload, phaseDigest } } as const;
  }

  #event(occurredAt: string, body: { type: string; payload: unknown }): PendingDomainEvent {
    return PendingDomainEventSchema.parse({
      workspaceId: this.#options.workspaceId,
      actor: ACTOR,
      correlationId: stableUuid(`${body.type}:${canonicalJson(body.payload)}`),
      occurredAt,
      type: body.type,
      payload: body.payload
    });
  }

  async #commit(
    snapshot: RunSnapshot,
    events: readonly PendingDomainEvent[],
    key: string
  ): Promise<void> {
    await this.#options.store.commit({
      idempotency: { scope: `local-execution:${snapshot.run.id}`, key },
      appends: [
        {
          stream: { kind: "run", id: snapshot.run.id },
          expectedVersion: snapshot.events.at(-1)?.streamVersion ?? 0,
          events
        }
      ],
      jobs: []
    });
  }
}
