import {
  ArtifactDescriptorSchema,
  CancelCommandRequestSchema,
  CancelCommandResponseSchema,
  CommandAcceptedSchema,
  CommandAuthorizationSchema,
  DisposeEnvironmentRequestSchema,
  DisposeEnvironmentResponseSchema,
  EnvironmentAuthorizationSchema,
  InspectRepositoryRequestSchema,
  PrepareEnvironmentRequestSchema,
  PreparedEnvironmentSchema,
  ReadArtifactChunkRequestSchema,
  ReadArtifactChunkResponseSchema,
  ReadCommandEventsRequestSchema,
  RepositoryInspectionSchema,
  RunnerCapabilitiesSchema,
  RunnerDrainResultSchema,
  RunnerSubscriptionItemSchema,
  StartCommandRequestSchema,
  createId,
  digestCommandAuthorization,
  digestCommandScope,
  digestCommandSpec,
  digestEnvironmentAuthorization,
  digestExecutionScope,
  digestVersionedValue,
  validateCommandAuthorizationAgainstEnvironment,
  type ArtifactDescriptor,
  type CancelCommandRequest,
  type CancelCommandResponse,
  type CommandAccepted,
  type CommandId,
  type DisposeEnvironmentRequest,
  type DisposeEnvironmentResponse,
  type EnvironmentId,
  type InspectRepositoryRequest,
  type PrepareEnvironmentRequest,
  type PreparedEnvironment,
  type ReadArtifactChunkRequest,
  type ReadArtifactChunkResponse,
  type ReadCommandEventsRequest,
  type RepositoryInspection,
  type RunnerCapabilities,
  type RunnerDrainResult,
  type RunnerStreamEvent,
  type RunnerSubscriptionItem,
  type StartCommandRequest,
  type TerminalRunEvidence
} from "@autostack/contracts";

import type {
  LocalRunnerLifecycle as DomainLifecycle,
  RunnerProvider as DomainProvider
} from "../../src/ports/runner-provider.js";
import type { RunnerProviderConformanceControl } from "../../src/testing/runner-provider-conformance.js";

const NOW = "2026-08-21T12:00:00.000Z";
const LATER = "2026-08-21T13:00:00.000Z";
const SOURCE_COMMIT = "a".repeat(40);
const ARTIFACT_CHUNK_LIMIT = 1_048_576;
const FOREIGN_DIGEST = "f".repeat(64);
const uuid = (suffix: string): string => `123e4567-e89b-42d3-a456-${suffix.padStart(12, "0")}`;
const id = {
  workspace: createId("workspace", uuid("1")),
  run: createId("run", uuid("2")),
  environment: createId("environment", uuid("3")),
  command: createId("command", uuid("4")),
  environmentAuthorization: createId("environmentAuthorization", uuid("5")),
  commandAuthorization: createId("commandAuthorization", uuid("6")),
  planApproval: createId("approval", uuid("7")),
  commandApproval: createId("approval", uuid("8")),
  artifact: createId("artifact", uuid("9")),
  credential: createId("credentialRef", uuid("10")),
  nextEnvironment: createId("environment", uuid("11")),
  nextEnvironmentAuthorization: createId("environmentAuthorization", uuid("12")),
  nextPlanApproval: createId("approval", uuid("13")),
  nextCommand: createId("command", uuid("14")),
  nextCommandAuthorization: createId("commandAuthorization", uuid("15")),
  nextCommandApproval: createId("approval", uuid("16")),
  foreignWorkspace: createId("workspace", uuid("101")),
  foreignRun: createId("run", uuid("102")),
  foreignEnvironment: createId("environment", uuid("103")),
  foreignCommand: createId("command", uuid("104")),
  foreignEnvironmentAuthorization: createId("environmentAuthorization", uuid("105")),
  foreignCommandAuthorization: createId("commandAuthorization", uuid("106")),
  foreignArtifact: createId("artifact", uuid("107"))
};

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(binary);
};

const buildEnvironmentAuthorization = async (input: {
  readonly environmentId: typeof id.environment | typeof id.nextEnvironment;
  readonly authorizationId:
    typeof id.environmentAuthorization | typeof id.nextEnvironmentAuthorization;
  readonly approvalId: typeof id.planApproval | typeof id.nextPlanApproval;
  readonly branch: string;
}) => {
  const scope = {
    workspaceId: id.workspace,
    runId: id.run,
    environmentId: input.environmentId,
    repositoryIdentity: "github:autostack/coding-factory",
    sourceCommit: SOURCE_COMMIT,
    branch: input.branch,
    cwdRoot: "packages/domain",
    resourceLimits: { cpu: 2, memoryMb: 512, durationSeconds: 120 },
    networkPolicy: "host" as const,
    filesystemDisclosure: "host_user" as const,
    allowedCredentialRefIds: [id.credential]
  };
  const authorization = {
    id: input.authorizationId,
    approvalId: input.approvalId,
    approvalEvidenceDigest: await digestExecutionScope(scope),
    scope,
    createdAt: NOW,
    expiresAt: LATER,
    digest: "0".repeat(64)
  };
  authorization.digest = await digestEnvironmentAuthorization(authorization);
  return EnvironmentAuthorizationSchema.parse(authorization);
};
const buildCommandAuthorization = async (input: {
  readonly commandId: typeof id.command | typeof id.nextCommand;
  readonly authorizationId: typeof id.commandAuthorization | typeof id.nextCommandAuthorization;
  readonly approvalId: typeof id.commandApproval | typeof id.nextCommandApproval;
  readonly environmentAuthorization: Awaited<ReturnType<typeof buildEnvironmentAuthorization>>;
  readonly command: StartCommandRequest["command"];
}) => {
  const environment = input.environmentAuthorization.scope;
  const scope = {
    environmentAuthorizationId: input.environmentAuthorization.id,
    environmentAuthorizationDigest: input.environmentAuthorization.digest,
    workspaceId: environment.workspaceId,
    runId: environment.runId,
    environmentId: environment.environmentId,
    commandId: input.commandId,
    action: "implement" as const,
    commandDigest: await digestCommandSpec(input.command),
    repositoryIdentity: environment.repositoryIdentity,
    sourceCommit: environment.sourceCommit,
    branch: environment.branch,
    cwdRoot: environment.cwdRoot,
    networkPolicy: environment.networkPolicy,
    filesystemDisclosure: environment.filesystemDisclosure,
    resourceLimits: { cpu: 1, memoryMb: 256, durationSeconds: 60 },
    allowedCredentialRefIds: [id.credential]
  };
  const authorization = {
    id: input.authorizationId,
    approvalId: input.approvalId,
    approvalEvidenceDigest: await digestCommandScope(scope),
    scope,
    createdAt: NOW,
    expiresAt: LATER,
    digest: "0".repeat(64)
  };
  authorization.digest = await digestCommandAuthorization(authorization);
  return CommandAuthorizationSchema.parse(authorization);
};

const primaryEnvironmentAuthorization = await buildEnvironmentAuthorization({
  environmentId: id.environment,
  authorizationId: id.environmentAuthorization,
  approvalId: id.planApproval,
  branch: "autostack/conformance"
});
const conflictingEnvironmentAuthorization = await buildEnvironmentAuthorization({
  environmentId: id.environment,
  authorizationId: id.environmentAuthorization,
  approvalId: id.planApproval,
  branch: "autostack/conflicting-conformance"
});
const nextEnvironmentAuthorization = await buildEnvironmentAuthorization({
  environmentId: id.nextEnvironment,
  authorizationId: id.nextEnvironmentAuthorization,
  approvalId: id.nextPlanApproval,
  branch: "autostack/next-conformance"
});
const command = {
  executable: "/usr/bin/git",
  args: ["status", "--short"],
  cwd: "packages/domain",
  environment: [
    { kind: "literal" as const, name: "AUTOSTACK_MODE", value: "conformance" },
    { kind: "credential_ref" as const, name: "AUTOSTACK_TOKEN", credentialRefId: id.credential }
  ],
  timeoutSeconds: 60,
  terminal: { columns: 96, rows: 30 }
};
const conflictingCommand = { ...command, args: ["status", "--porcelain=v2"] };
const nextCommand = { ...command, args: ["diff", "--stat"] };
const primaryCommandAuthorization = await buildCommandAuthorization({
  commandId: id.command,
  authorizationId: id.commandAuthorization,
  approvalId: id.commandApproval,
  environmentAuthorization: primaryEnvironmentAuthorization,
  command
});
const conflictingCommandAuthorization = await buildCommandAuthorization({
  commandId: id.command,
  authorizationId: id.commandAuthorization,
  approvalId: id.commandApproval,
  environmentAuthorization: primaryEnvironmentAuthorization,
  command: conflictingCommand
});
const nextCommandAuthorization = await buildCommandAuthorization({
  commandId: id.nextCommand,
  authorizationId: id.nextCommandAuthorization,
  approvalId: id.nextCommandApproval,
  environmentAuthorization: primaryEnvironmentAuthorization,
  command: nextCommand
});

const inspectionRequest = InspectRepositoryRequestSchema.parse({
  sourcePath: "/tmp/autostack-conformance/source",
  baseRef: "main"
});
const inspection = RepositoryInspectionSchema.parse({
  repositoryIdentity: primaryEnvironmentAuthorization.scope.repositoryIdentity,
  canonicalSourcePath: inspectionRequest.sourcePath,
  repositoryCommonDirectory: `${inspectionRequest.sourcePath}/.git`,
  remoteIdentity: "https://example.test/autostack/coding-factory.git",
  resolvedBaseRef: inspectionRequest.baseRef,
  sourceCommit: SOURCE_COMMIT,
  dirty: false,
  diagnostics: ["conformance fixture"]
});
const prepare = PrepareEnvironmentRequestSchema.parse({
  workspaceId: id.workspace,
  runId: id.run,
  environmentId: id.environment,
  inspection,
  sourceCommit: SOURCE_COMMIT,
  branch: primaryEnvironmentAuthorization.scope.branch,
  authorization: primaryEnvironmentAuthorization,
  idempotency: { key: "prepare-primary" }
});
const conflictingPrepare = PrepareEnvironmentRequestSchema.parse({
  ...prepare,
  branch: conflictingEnvironmentAuthorization.scope.branch,
  authorization: conflictingEnvironmentAuthorization
});
const nextPrepare = PrepareEnvironmentRequestSchema.parse({
  ...prepare,
  environmentId: id.nextEnvironment,
  branch: nextEnvironmentAuthorization.scope.branch,
  authorization: nextEnvironmentAuthorization,
  idempotency: { key: "prepare-next" }
});
const start = StartCommandRequestSchema.parse({
  workspaceId: id.workspace,
  runId: id.run,
  environmentId: id.environment,
  commandId: id.command,
  command,
  environmentAuthorizationId: primaryEnvironmentAuthorization.id,
  environmentAuthorizationDigest: primaryEnvironmentAuthorization.digest,
  authorization: primaryCommandAuthorization,
  idempotency: { key: "start-primary" }
});
const conflictingStart = StartCommandRequestSchema.parse({
  ...start,
  command: conflictingCommand,
  authorization: conflictingCommandAuthorization
});
const nextStart = StartCommandRequestSchema.parse({
  ...start,
  commandId: id.nextCommand,
  command: nextCommand,
  authorization: nextCommandAuthorization,
  idempotency: { key: "start-next" }
});
const events = ReadCommandEventsRequestSchema.parse({
  workspaceId: id.workspace,
  runId: id.run,
  environmentId: id.environment,
  commandId: id.command,
  environmentAuthorizationId: primaryEnvironmentAuthorization.id,
  environmentAuthorizationDigest: primaryEnvironmentAuthorization.digest,
  commandAuthorizationId: primaryCommandAuthorization.id,
  commandAuthorizationDigest: primaryCommandAuthorization.digest,
  after: 0
});
const cancel = CancelCommandRequestSchema.parse({
  workspaceId: events.workspaceId,
  runId: events.runId,
  environmentId: events.environmentId,
  commandId: events.commandId,
  environmentAuthorizationId: events.environmentAuthorizationId,
  environmentAuthorizationDigest: events.environmentAuthorizationDigest,
  commandAuthorizationId: events.commandAuthorizationId,
  commandAuthorizationDigest: events.commandAuthorizationDigest,
  idempotency: { key: "cancel-primary" }
});
const artifactBytes = Uint8Array.from(
  { length: ARTIFACT_CHUNK_LIMIT + 137 },
  (_unused, index) => (index * 31 + 17) % 256
);
const artifactDigest = await sha256(artifactBytes);
const artifact = ReadArtifactChunkRequestSchema.parse({
  workspaceId: events.workspaceId,
  runId: events.runId,
  environmentId: events.environmentId,
  commandId: events.commandId,
  environmentAuthorizationId: events.environmentAuthorizationId,
  environmentAuthorizationDigest: events.environmentAuthorizationDigest,
  commandAuthorizationId: events.commandAuthorizationId,
  commandAuthorizationDigest: events.commandAuthorizationDigest,
  artifactId: id.artifact,
  offset: 0,
  length: ARTIFACT_CHUNK_LIMIT
});
const terminalRunEvidence: TerminalRunEvidence = {
  status: "completed",
  terminalEventSequence: 23,
  terminalEventDigest: await digestVersionedValue("autostack.conformance-terminal-run", {
    workspaceId: id.workspace,
    runId: id.run,
    status: "completed",
    sequence: 23
  })
};
const dispose = DisposeEnvironmentRequestSchema.parse({
  workspaceId: id.workspace,
  runId: id.run,
  environmentId: id.environment,
  environmentAuthorizationId: primaryEnvironmentAuthorization.id,
  environmentAuthorizationDigest: primaryEnvironmentAuthorization.digest,
  terminalRunEvidence,
  idempotency: { key: "dispose-primary" }
});

const prepareWrongAuthorizationDigest = PrepareEnvironmentRequestSchema.parse({
  ...prepare,
  authorization: { ...prepare.authorization, digest: FOREIGN_DIGEST }
});
const environmentWrongApprovalEvidenceCandidate = {
  ...prepare.authorization,
  approvalEvidenceDigest: FOREIGN_DIGEST,
  digest: "0".repeat(64)
};
environmentWrongApprovalEvidenceCandidate.digest = await digestEnvironmentAuthorization(
  environmentWrongApprovalEvidenceCandidate
);
const prepareWrongApprovalEvidence = PrepareEnvironmentRequestSchema.parse({
  ...prepare,
  authorization: EnvironmentAuthorizationSchema.parse(environmentWrongApprovalEvidenceCandidate)
});
const startWrongAuthorizationDigest = StartCommandRequestSchema.parse({
  ...start,
  authorization: { ...start.authorization, digest: FOREIGN_DIGEST }
});
const commandWrongApprovalEvidenceCandidate = {
  ...start.authorization,
  approvalEvidenceDigest: FOREIGN_DIGEST,
  digest: "0".repeat(64)
};
commandWrongApprovalEvidenceCandidate.digest = await digestCommandAuthorization(
  commandWrongApprovalEvidenceCandidate
);
const startWrongApprovalEvidence = StartCommandRequestSchema.parse({
  ...start,
  authorization: CommandAuthorizationSchema.parse(commandWrongApprovalEvidenceCandidate)
});
const startCommandSpecMismatch = StartCommandRequestSchema.parse({
  ...start,
  command: { ...start.command, args: ["status", "--ignored-by-authorization"] }
});
const broadenedCommandScope = {
  ...start.authorization.scope,
  resourceLimits: {
    ...start.authorization.scope.resourceLimits,
    cpu: prepare.authorization.scope.resourceLimits.cpu + 1
  }
};
const broadenedCommandAuthorizationCandidate = {
  ...start.authorization,
  scope: broadenedCommandScope,
  approvalEvidenceDigest: await digestCommandScope(broadenedCommandScope),
  digest: "0".repeat(64)
};
broadenedCommandAuthorizationCandidate.digest = await digestCommandAuthorization(
  broadenedCommandAuthorizationCandidate
);
const startBroadenedAuthorization = StartCommandRequestSchema.parse({
  ...start,
  authorization: CommandAuthorizationSchema.parse(broadenedCommandAuthorizationCandidate)
});

interface Subscriber {
  readonly queue: RunnerSubscriptionItem[];
  cursor: number;
  endedAfterQueue: boolean;
  wake: (() => void) | undefined;
}
interface CommandRecord {
  readonly request: StartCommandRequest;
  readonly requestDigest: string;
  readonly events: RunnerStreamEvent[];
  readonly subscribers: Set<Subscriber>;
  active: boolean;
  artifact: ArtifactDescriptor | undefined;
  cancelDigest: string | undefined;
  cancelResponse: CancelCommandResponse | undefined;
}

const requireRunnerEvent = (item: RunnerSubscriptionItem): RunnerStreamEvent => {
  if (item.type !== "runner.event") throw new TypeError("Expected a durable runner event.");
  return item.event;
};

class StatefulInMemoryRunner implements DomainProvider, DomainLifecycle {
  private readonly prepared = new Map<EnvironmentId, PreparedEnvironment>();
  private readonly prepareDigests = new Map<EnvironmentId, string>();
  private readonly commands = new Map<CommandId, CommandRecord>();
  private readonly authoritativeTerminalEvidence = new Map<EnvironmentId, TerminalRunEvidence>();
  private readonly disposalDigests = new Map<EnvironmentId, string>();
  private readonly disposed = new Set<EnvironmentId>();
  private quiesced = false;
  private closed = false;

  private assertOpen(): void {
    if (this.closed) throw new Error("runner is closed");
  }
  private assertCommandOwnership(
    record: CommandRecord,
    request: ReadCommandEventsRequest | CancelCommandRequest | ReadArtifactChunkRequest
  ): void {
    const started = record.request;
    if (
      request.workspaceId !== started.workspaceId ||
      request.runId !== started.runId ||
      request.environmentId !== started.environmentId ||
      request.commandId !== started.commandId ||
      request.environmentAuthorizationId !== started.environmentAuthorizationId ||
      request.environmentAuthorizationDigest !== started.environmentAuthorizationDigest ||
      request.commandAuthorizationId !== started.authorization.id ||
      request.commandAuthorizationDigest !== started.authorization.digest
    )
      throw new Error("command ownership or authorization mismatch");
  }

  async capabilities(): Promise<RunnerCapabilities> {
    this.assertOpen();
    return RunnerCapabilitiesSchema.parse({
      runnerId: "stateful-conformance-runner",
      version: "1.0.0",
      platform: { os: "darwin", architecture: "arm64" },
      pty: true,
      cancellation: true,
      filesystemDisclosure: "host_user",
      maximumBytes: {
        liveOutput: 65_536,
        replay: 1_048_576,
        transcript: 4_194_304,
        artifact: 8_388_608
      },
      supportedNetworkPolicies: ["host"],
      enforcement: {
        cpu: "advisory",
        memory: "advisory",
        duration: "hard",
        autostackPathOperations: "hard",
        childFilesystem: "advisory",
        network: "unavailable"
      }
    });
  }
  async inspectRepository(
    requestCandidate: InspectRepositoryRequest
  ): Promise<RepositoryInspection> {
    this.assertOpen();
    const request = InspectRepositoryRequestSchema.parse(requestCandidate);
    if (
      request.sourcePath !== inspectionRequest.sourcePath ||
      request.baseRef !== inspectionRequest.baseRef
    )
      throw new Error("unknown repository inspection");
    return structuredClone(inspection);
  }
  async prepareEnvironment(
    requestCandidate: PrepareEnvironmentRequest
  ): Promise<PreparedEnvironment> {
    this.assertOpen();
    if (this.quiesced) throw new Error("runner is quiesced");
    const request = PrepareEnvironmentRequestSchema.parse(requestCandidate);
    if (
      (await digestEnvironmentAuthorization(request.authorization)) !==
        request.authorization.digest ||
      (await digestExecutionScope(request.authorization.scope)) !==
        request.authorization.approvalEvidenceDigest
    )
      throw new Error("invalid environment authorization evidence");
    const requestDigest = await digestVersionedValue(
      "autostack.conformance.prepare-request",
      request
    );
    const retained = this.prepared.get(request.environmentId);
    if (retained !== undefined) {
      if (this.prepareDigests.get(request.environmentId) !== requestDigest)
        throw new Error("environment request conflict");
      return structuredClone(retained);
    }
    if (this.disposed.has(request.environmentId)) throw new Error("environment is disposed");
    const environment = PreparedEnvironmentSchema.parse({
      environmentId: request.environmentId,
      workspaceId: request.workspaceId,
      runId: request.runId,
      repositoryIdentity: request.inspection.repositoryIdentity,
      sourceCommit: request.sourceCommit,
      branch: request.branch,
      authorization: request.authorization,
      state: "prepared",
      preparedAt: NOW
    });
    this.prepareDigests.set(request.environmentId, requestDigest);
    this.prepared.set(request.environmentId, structuredClone(environment));
    return structuredClone(environment);
  }
  async listEnvironments(): Promise<readonly PreparedEnvironment[]> {
    this.assertOpen();
    return [...this.prepared.values()].map((environment) => structuredClone(environment));
  }
  async startCommand(requestCandidate: StartCommandRequest): Promise<CommandAccepted> {
    this.assertOpen();
    if (this.quiesced) throw new Error("runner is quiesced");
    const request = StartCommandRequestSchema.parse(requestCandidate);
    const environment = this.prepared.get(request.environmentId);
    if (environment === undefined || this.disposed.has(request.environmentId))
      throw new Error("environment is unavailable");
    if (
      request.environmentAuthorizationId !== environment.authorization.id ||
      request.environmentAuthorizationDigest !== environment.authorization.digest ||
      (await digestCommandSpec(request.command)) !== request.authorization.scope.commandDigest ||
      (await digestCommandScope(request.authorization.scope)) !==
        request.authorization.approvalEvidenceDigest ||
      (await digestCommandAuthorization(request.authorization)) !== request.authorization.digest
    )
      throw new Error("invalid command authorization evidence");
    validateCommandAuthorizationAgainstEnvironment(
      request.authorization,
      environment.authorization
    );
    const requestDigest = await digestVersionedValue(
      "autostack.conformance.start-request",
      request
    );
    const retained = this.commands.get(request.commandId);
    if (retained !== undefined) {
      if (retained.requestDigest !== requestDigest) throw new Error("command request conflict");
      return CommandAcceptedSchema.parse({
        commandId: request.commandId,
        acceptedAt: NOW,
        replayed: true
      });
    }
    const started = RunnerSubscriptionItemSchema.parse({
      type: "runner.event",
      event: {
        type: "command.started",
        workspaceId: request.workspaceId,
        runId: request.runId,
        commandId: request.commandId,
        sequence: 1,
        occurredAt: NOW,
        pty: true
      }
    });
    this.commands.set(request.commandId, {
      request: structuredClone(request),
      requestDigest,
      events: [requireRunnerEvent(started)],
      subscribers: new Set(),
      active: true,
      artifact: undefined,
      cancelDigest: undefined,
      cancelResponse: undefined
    });
    return CommandAcceptedSchema.parse({
      commandId: request.commandId,
      acceptedAt: NOW,
      replayed: false
    });
  }

  readCommandEvents(
    requestCandidate: ReadCommandEventsRequest
  ): AsyncIterable<RunnerSubscriptionItem> {
    const runner = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<RunnerSubscriptionItem> {
        let subscriber: Subscriber | undefined;
        const initialize = (): Subscriber => {
          runner.assertOpen();
          const request = ReadCommandEventsRequestSchema.parse(requestCandidate);
          const record = runner.commands.get(request.commandId);
          if (record === undefined) throw new Error("unknown command");
          runner.assertCommandOwnership(record, request);
          const created: Subscriber = {
            queue: record.events
              .filter((event) => event.sequence > request.after)
              .map((event) => ({ type: "runner.event", event })),
            cursor: request.after,
            endedAfterQueue: !record.active,
            wake: undefined
          };
          if (record.active) record.subscribers.add(created);
          subscriber = created;
          return created;
        };
        return {
          async next(): Promise<IteratorResult<RunnerSubscriptionItem>> {
            const current = subscriber ?? initialize();
            for (;;) {
              const item = current.queue.shift();
              if (item !== undefined) {
                if (item.type === "runner.event") current.cursor = item.event.sequence;
                if (
                  item.type === "subscription.lagged" ||
                  (item.type === "runner.event" &&
                    (item.event.type === "command.completed" || item.event.type === "stream.error"))
                )
                  current.endedAfterQueue = true;
                return { done: false, value: structuredClone(item) };
              }
              if (current.endedAfterQueue) return { done: true, value: undefined };
              await new Promise<void>((resolve) => {
                current.wake = resolve;
              });
              current.wake = undefined;
            }
          }
        };
      }
    };
  }

  private publish(record: CommandRecord, event: RunnerStreamEvent): void {
    record.events.push(event);
    for (const subscriber of [...record.subscribers]) {
      if (subscriber.queue.length >= 2) {
        subscriber.queue.splice(0, subscriber.queue.length, {
          type: "subscription.lagged",
          lastDurableSequence: subscriber.cursor,
          resumeCursor: subscriber.cursor
        });
        subscriber.endedAfterQueue = true;
        record.subscribers.delete(subscriber);
      } else {
        subscriber.queue.push({ type: "runner.event", event });
        if (event.type === "command.completed" || event.type === "stream.error")
          record.subscribers.delete(subscriber);
      }
      subscriber.wake?.();
    }
  }

  private async finish(
    commandId: CommandId,
    disposition: "completed" | "cancelled" | "interrupted"
  ): Promise<void> {
    const record = this.commands.get(commandId);
    if (record === undefined) throw new Error("unknown command");
    if (!record.active) return;
    const descriptor = ArtifactDescriptorSchema.parse({
      artifactId: id.artifact,
      workspaceId: record.request.workspaceId,
      runId: record.request.runId,
      commandId,
      kind: "command_transcript",
      mediaType: "application/octet-stream",
      digest: artifactDigest,
      byteSize: artifactBytes.byteLength,
      createdAt: NOW
    });
    record.artifact = descriptor;
    record.active = false;
    const bodies: RunnerStreamEvent[] = ["one", "two", "three", "four"].map((text, index) => {
      const item = RunnerSubscriptionItemSchema.parse({
        type: "runner.event",
        event: {
          type: "terminal.output",
          workspaceId: record.request.workspaceId,
          runId: record.request.runId,
          commandId,
          sequence: index + 2,
          occurredAt: NOW,
          stream: "pty",
          text
        }
      });
      return requireRunnerEvent(item);
    });
    const artifactItem = RunnerSubscriptionItemSchema.parse({
      type: "runner.event",
      event: {
        type: "artifact.created",
        workspaceId: record.request.workspaceId,
        runId: record.request.runId,
        commandId,
        sequence: 6,
        occurredAt: NOW,
        artifact: descriptor
      }
    });
    const completedItem = RunnerSubscriptionItemSchema.parse({
      type: "runner.event",
      event: {
        type: "command.completed",
        workspaceId: record.request.workspaceId,
        runId: record.request.runId,
        commandId,
        sequence: 7,
        occurredAt: NOW,
        exitCode: disposition === "interrupted" ? null : disposition === "cancelled" ? 130 : 0,
        signal: disposition === "interrupted" ? "SIGTERM" : null,
        durationMs: 25,
        cancelled: disposition === "cancelled",
        interrupted: disposition === "interrupted",
        transcript: descriptor
      }
    });
    bodies.push(requireRunnerEvent(artifactItem), requireRunnerEvent(completedItem));
    for (const event of bodies) {
      this.publish(record, event);
      await Promise.resolve();
    }
  }

  async cancelCommand(requestCandidate: CancelCommandRequest): Promise<CancelCommandResponse> {
    this.assertOpen();
    const request = CancelCommandRequestSchema.parse(requestCandidate);
    const record = this.commands.get(request.commandId);
    if (record === undefined) throw new Error("unknown command");
    this.assertCommandOwnership(record, request);
    const digest = await digestVersionedValue("autostack.conformance.cancel-request", request);
    if (record.cancelResponse !== undefined) {
      if (record.cancelDigest !== digest) throw new Error("cancel request conflict");
      return CancelCommandResponseSchema.parse({ ...record.cancelResponse, replayed: true });
    }
    const cancelled = record.active;
    if (cancelled) await this.finish(request.commandId, "cancelled");
    record.cancelDigest = digest;
    record.cancelResponse = CancelCommandResponseSchema.parse({
      commandId: request.commandId,
      cancelled,
      replayed: false
    });
    return structuredClone(record.cancelResponse);
  }

  async readArtifactChunk(
    requestCandidate: ReadArtifactChunkRequest
  ): Promise<ReadArtifactChunkResponse> {
    this.assertOpen();
    const request = ReadArtifactChunkRequestSchema.parse(requestCandidate);
    const record = this.commands.get(request.commandId);
    if (record === undefined) throw new Error("unknown command");
    this.assertCommandOwnership(record, request);
    const descriptor = record.artifact;
    if (descriptor === undefined || request.artifactId !== descriptor.artifactId)
      throw new Error("unknown artifact");
    if (request.offset > artifactBytes.byteLength) throw new Error("artifact offset out of range");
    const nextOffset = Math.min(request.offset + request.length, artifactBytes.byteLength);
    return ReadArtifactChunkResponseSchema.parse({
      artifact: descriptor,
      offset: request.offset,
      bytes: toBase64(artifactBytes.subarray(request.offset, nextOffset)),
      nextOffset,
      done: nextOffset === artifactBytes.byteLength
    });
  }

  async disposeEnvironment(
    requestCandidate: DisposeEnvironmentRequest
  ): Promise<DisposeEnvironmentResponse> {
    this.assertOpen();
    const request = DisposeEnvironmentRequestSchema.parse(requestCandidate);
    const environment = this.prepared.get(request.environmentId);
    if (
      environment === undefined ||
      request.workspaceId !== environment.workspaceId ||
      request.runId !== environment.runId ||
      request.environmentAuthorizationId !== environment.authorization.id ||
      request.environmentAuthorizationDigest !== environment.authorization.digest
    )
      throw new Error("environment ownership or authorization mismatch");
    if (
      [...this.commands.values()].some(
        (record) => record.request.environmentId === request.environmentId && record.active
      )
    )
      throw new Error("environment has an active command");
    const authoritative = this.authoritativeTerminalEvidence.get(request.environmentId);
    if (
      authoritative === undefined ||
      authoritative.status !== request.terminalRunEvidence.status ||
      authoritative.terminalEventSequence !== request.terminalRunEvidence.terminalEventSequence ||
      authoritative.terminalEventDigest !== request.terminalRunEvidence.terminalEventDigest
    )
      throw new Error("terminal evidence is not authoritative");
    const requestDigest = await digestVersionedValue(
      "autostack.conformance.dispose-request",
      request
    );
    const retainedDigest = this.disposalDigests.get(request.environmentId);
    if (retainedDigest !== undefined) {
      if (retainedDigest !== requestDigest) throw new Error("dispose request conflict");
      return DisposeEnvironmentResponseSchema.parse({
        environmentId: request.environmentId,
        disposed: true,
        replayed: true
      });
    }
    this.disposalDigests.set(request.environmentId, requestDigest);
    this.prepared.delete(request.environmentId);
    this.disposed.add(request.environmentId);
    return DisposeEnvironmentResponseSchema.parse({
      environmentId: request.environmentId,
      disposed: true,
      replayed: false
    });
  }

  async quiesce(): Promise<void> {
    this.assertOpen();
    this.quiesced = true;
  }
  async interruptAndDrain(): Promise<RunnerDrainResult> {
    this.assertOpen();
    const interruptedCommandIds = [...this.commands.entries()]
      .filter(([, record]) => record.active)
      .map(([commandId]) => commandId);
    for (const commandId of interruptedCommandIds) await this.finish(commandId, "interrupted");
    return RunnerDrainResultSchema.parse({
      interruptedCommandIds,
      releasedGuardianLeaseCount: interruptedCommandIds.length,
      remainingGuardianLeaseCount: 0
    });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
  }
  async completeCommand(commandId: CommandId): Promise<void> {
    this.assertOpen();
    await this.finish(commandId, "completed");
  }
  async recordTerminalRunEvidence(
    environmentId: EnvironmentId,
    evidence: TerminalRunEvidence
  ): Promise<void> {
    this.assertOpen();
    this.authoritativeTerminalEvidence.set(environmentId, structuredClone(evidence));
  }
  async inspectRetainedCommand(commandId: CommandId): Promise<StartCommandRequest | undefined> {
    const request = this.commands.get(commandId)?.request;
    return request === undefined ? undefined : structuredClone(request);
  }
  async guardianLeaseCount(): Promise<number> {
    return [...this.commands.values()].filter((record) => record.active).length;
  }
}

const createRunner = async (): Promise<{
  readonly runner: StatefulInMemoryRunner;
  readonly control: RunnerProviderConformanceControl;
}> => {
  const runner = new StatefulInMemoryRunner();
  return { runner, control: runner };
};
const sharedFixture = {
  inspectionRequest,
  prepare,
  conflictingPrepare,
  nextPrepare,
  start,
  conflictingStart,
  nextStart,
  events,
  cancel,
  artifact,
  dispose,
  expectedArtifactBytes: artifactBytes,
  foreign: {
    workspaceId: id.foreignWorkspace,
    runId: id.foreignRun,
    environmentId: id.foreignEnvironment,
    commandId: id.foreignCommand,
    environmentAuthorizationId: id.foreignEnvironmentAuthorization,
    commandAuthorizationId: id.foreignCommandAuthorization,
    artifactId: id.foreignArtifact,
    digest: FOREIGN_DIGEST
  },
  tampered: {
    prepareWrongAuthorizationDigest,
    prepareWrongApprovalEvidence,
    startWrongAuthorizationDigest,
    startWrongApprovalEvidence,
    startCommandSpecMismatch,
    startBroadenedAuthorization
  }
};

export const runnerProviderConformanceFixture = {
  ...sharedFixture,
  create: async () => {
    const { runner, control } = await createRunner();
    return { provider: runner, control };
  }
};
export const localRunnerLifecycleConformanceFixture = {
  ...sharedFixture,
  create: async () => {
    const { runner, control } = await createRunner();
    return { provider: runner, lifecycle: runner, control };
  }
};
