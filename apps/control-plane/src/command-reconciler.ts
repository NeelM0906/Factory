import {
  ReadCommandEventsRequestSchema,
  type ArtifactDescriptor,
  type ArtifactId,
  type CommandId,
  type ReadArtifactChunkRequest,
  type ReadCommandEventsRequest,
  type RunnerStreamEvent,
  type RunnerSubscriptionItem
} from "@autostack/contracts";

export type ReconciliationResult = "completed" | "pending";

interface CommandEventSource {
  openCommandEvents(request: ReadCommandEventsRequest): AsyncIterable<RunnerSubscriptionItem>;
}

type ArtifactOwnership = Omit<ReadArtifactChunkRequest, "artifactId" | "offset" | "length">;

interface ArtifactVerifier {
  verifyFinalizedArtifact(
    descriptor: ArtifactDescriptor,
    ownership: ArtifactOwnership
  ): Promise<ArtifactDescriptor>;
}

export interface CommandEvidenceSink {
  recordStarted(
    event: Extract<RunnerStreamEvent, { readonly type: "command.started" }>
  ): Promise<void>;
  recordArtifact(descriptor: ArtifactDescriptor, hostSequence: number): Promise<void>;
  hasArtifact(artifactId: ArtifactId): Promise<boolean>;
  hasVerifiedTranscript(commandId: CommandId): Promise<boolean>;
  recordCompletion(
    event: Extract<RunnerStreamEvent, { readonly type: "command.completed" | "stream.error" }>
  ): Promise<void>;
}

export interface CommandReconcilerDependencies {
  readonly host: CommandEventSource;
  readonly artifacts: ArtifactVerifier;
  readonly evidence: CommandEvidenceSink;
  readonly maximumReconnects?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export class CommandReconciler {
  readonly #dependencies: CommandReconcilerDependencies;
  readonly #maximumReconnects: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #active = new Map<
    string,
    { readonly canonicalRequest: string; readonly operation: Promise<ReconciliationResult> }
  >();

  constructor(dependencies: CommandReconcilerDependencies) {
    const maximumReconnects = dependencies.maximumReconnects ?? 3;
    if (!Number.isSafeInteger(maximumReconnects) || maximumReconnects < 0) {
      throw new TypeError("Reconnect limit is invalid.");
    }
    this.#dependencies = dependencies;
    this.#maximumReconnects = maximumReconnects;
    this.#sleep = dependencies.sleep ?? (async () => undefined);
  }

  reconcile(requestCandidate: ReadCommandEventsRequest): Promise<ReconciliationResult> {
    const request = ReadCommandEventsRequestSchema.parse(structuredClone(requestCandidate));
    const canonicalRequest = JSON.stringify(request);
    const current = this.#active.get(request.commandId);
    if (current !== undefined) {
      return current.canonicalRequest === canonicalRequest
        ? current.operation
        : Promise.reject(new TypeError("Active command reconciliation ownership differs."));
    }
    const operation = this.#follow(request).finally(() => {
      if (this.#active.get(request.commandId)?.operation === operation)
        this.#active.delete(request.commandId);
    });
    this.#active.set(request.commandId, { canonicalRequest, operation });
    return operation;
  }

  async #follow(initialRequest: ReadCommandEventsRequest): Promise<ReconciliationResult> {
    let cursor = initialRequest.after;
    let reconnects = 0;
    let verifiedTranscript = false;
    const { after: _after, ...ownership } = initialRequest;
    while (reconnects <= this.#maximumReconnects) {
      let progressed = false;
      let lagged = false;
      try {
        for await (const item of this.#dependencies.host.openCommandEvents({
          ...initialRequest,
          after: cursor
        })) {
          if (item.type === "subscription.lagged") {
            cursor = item.resumeCursor;
            lagged = true;
            break;
          }
          const event = item.event;
          if (event.type === "command.started") {
            await this.#dependencies.evidence.recordStarted(event);
            cursor = event.sequence;
            progressed = true;
            continue;
          }
          if (event.type === "artifact.created") {
            const verified = await this.#dependencies.artifacts.verifyFinalizedArtifact(
              event.artifact,
              ownership
            );
            await this.#dependencies.evidence.recordArtifact(verified, event.sequence);
            if (verified.kind === "command_transcript") verifiedTranscript = true;
            cursor = event.sequence;
            progressed = true;
            continue;
          }
          if (event.type === "command.completed") {
            if (!(await this.#dependencies.evidence.hasArtifact(event.transcript.artifactId))) {
              const verified = await this.#dependencies.artifacts.verifyFinalizedArtifact(
                event.transcript,
                ownership
              );
              await this.#dependencies.evidence.recordArtifact(verified, cursor);
            }
            await this.#dependencies.evidence.recordCompletion(event);
            return "completed";
          }
          if (event.type === "stream.error") {
            if (
              !verifiedTranscript &&
              !(await this.#dependencies.evidence.hasVerifiedTranscript(event.commandId))
            )
              return "pending";
            await this.#dependencies.evidence.recordCompletion(event);
            return "completed";
          }
          cursor = event.sequence;
          progressed = true;
        }
      } catch {
        // Transport and hostile-response failures remain retryable only in this owner.
      }
      if (progressed) reconnects = 0;
      else reconnects += 1;
      if (reconnects > this.#maximumReconnects) return "pending";
      await this.#sleep(Math.min(25 * 2 ** Math.max(0, reconnects - 1), 200));
      if (lagged) continue;
    }
    return "pending";
  }
}
