import {
  CreateRunResponseSchema,
  ListEventsResponseSchema,
  ListRunsResponseSchema,
  RunIdSchema,
  type Actor,
  type CreateRunRequestInput,
  type CreateRunResponse,
  type IdFactory,
  type ListEventsResponse,
  type ListRunsResponse,
  type RunId,
  type StoredDomainEvent,
  type WorkspaceId
} from "@autostack/contracts";
import { createManualRun, projectRunSummaries, type DurableStore } from "@autostack/domain";

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} was not found.`);
    this.name = "RunNotFoundError";
  }
}

export interface RunServiceDependencies {
  readonly store: DurableStore;
  readonly workspaceId: WorkspaceId;
  readonly ids: Pick<IdFactory, "workItem" | "run">;
  readonly now: () => string;
  readonly correlationId: () => string;
}

const LOCAL_ACTOR: Actor = { kind: "user", id: "local-user", displayName: "Local User" };

export class RunService {
  readonly #dependencies: RunServiceDependencies;

  constructor(dependencies: RunServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async create(input: CreateRunRequestInput, idempotencyKey: string): Promise<CreateRunResponse> {
    const decision = createManualRun(
      input,
      {
        workspaceId: this.#dependencies.workspaceId,
        actor: LOCAL_ACTOR,
        correlationId: this.#dependencies.correlationId()
      },
      { now: this.#dependencies.now, ids: this.#dependencies.ids }
    );
    const result = await this.#dependencies.store.commit({
      idempotency: {
        scope: `api:create-run:${this.#dependencies.workspaceId}`,
        key: idempotencyKey
      },
      appends: decision.appends,
      jobs: decision.jobs
    });
    const workItemEvent = result.events.find((event) => event.type === "work_item.created");
    const runEvent = result.events.find((event) => event.type === "run.created");
    if (workItemEvent?.type !== "work_item.created" || runEvent?.type !== "run.created") {
      throw new Error("A create-run commit did not return its creation events.");
    }

    return CreateRunResponseSchema.parse({
      workItem: workItemEvent.payload.workItem,
      run: runEvent.payload.run,
      replayed: result.replayed
    });
  }

  async list(): Promise<ListRunsResponse> {
    const { events } = await this.#readAllWorkspaceEvents(0);
    return ListRunsResponseSchema.parse({ items: projectRunSummaries(events) });
  }

  async events(runIdInput: string, afterSequence: number): Promise<ListEventsResponse> {
    const runId: RunId = RunIdSchema.parse(runIdInput);
    const existing = await this.#dependencies.store.readStream({
      stream: { kind: "run", id: runId },
      afterVersion: 0
    });
    if (
      !existing.some(
        (event) =>
          event.type === "run.created" &&
          event.workspaceId === this.#dependencies.workspaceId &&
          event.payload.run.workspaceId === this.#dependencies.workspaceId
      )
    ) {
      throw new RunNotFoundError(runId);
    }
    const page = await this.#readAllWorkspaceEvents(afterSequence);
    const events = page.events.filter(
      (event) => event.stream.kind === "run" && event.stream.id === runId
    );

    return ListEventsResponseSchema.parse({
      events,
      nextSequence: page.nextSequence
    });
  }

  async #readAllWorkspaceEvents(afterGlobalSequence: number): Promise<{
    readonly events: readonly StoredDomainEvent[];
    readonly nextSequence: number;
  }> {
    const events: StoredDomainEvent[] = [];
    let cursor = afterGlobalSequence;
    while (true) {
      const page = await this.#dependencies.store.readAll({
        workspaceId: this.#dependencies.workspaceId,
        afterGlobalSequence: cursor,
        limit: 500
      });
      events.push(...page);
      const next = page.at(-1)?.globalSequence;
      if (next === undefined) break;
      if (next <= cursor) throw new Error("The event store returned a non-advancing cursor.");
      cursor = next;
      if (page.length < 500) break;
    }
    return { events, nextSequence: cursor };
  }
}
