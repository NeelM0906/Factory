import { createHash } from "node:crypto";

import {
  CreateRunResponseSchema,
  CreateRunRequestSchema,
  ListEventsResponseSchema,
  ListRunsResponseSchema,
  RunIdSchema,
  WorkItemIdSchema,
  type Actor,
  type CreateRunRequestInput,
  type CreateRunResponse,
  type ListEventsResponse,
  type ListRunsResponse,
  type RunId,
  type WorkspaceId
} from "@autostack/contracts";
import {
  canonicalJson,
  createManualRun,
  type CommitResult,
  type DurableStore
} from "@autostack/domain";

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} was not found.`);
    this.name = "RunNotFoundError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("The idempotency key is already bound to another request.");
    this.name = "IdempotencyConflictError";
  }
}

export interface RunServiceDependencies {
  readonly store: DurableStore;
  readonly workspaceId: WorkspaceId;
  readonly now: () => string;
}

const LOCAL_ACTOR: Actor = { kind: "user", id: "local-user", displayName: "Local User" };

export class RunService {
  readonly #dependencies: RunServiceDependencies;

  constructor(dependencies: RunServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async create(input: CreateRunRequestInput, idempotencyKey: string): Promise<CreateRunResponse> {
    const request = CreateRunRequestSchema.parse(input);
    const idempotency = {
      scope: `api:create-run:${this.#dependencies.workspaceId}`,
      key: idempotencyKey
    };
    const replay = await this.#dependencies.store.readCommitResult(idempotency);
    if (replay !== null) return this.#createResponse(request, replay);
    const stableUuid = (label: string): string => {
      const characters = createHash("sha256")
        .update(`${this.#dependencies.workspaceId}:${idempotencyKey}:${label}`)
        .digest("hex")
        .slice(0, 32)
        .split("");
      characters[12] = "4";
      characters[16] = "8";
      const value = characters.join("");
      return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
    };
    const decision = createManualRun(
      request,
      {
        workspaceId: this.#dependencies.workspaceId,
        actor: LOCAL_ACTOR,
        correlationId: stableUuid("correlation")
      },
      {
        now: this.#dependencies.now,
        ids: {
          workItem: () => WorkItemIdSchema.parse(`wi_${stableUuid("work-item")}`),
          run: () => RunIdSchema.parse(`run_${stableUuid("run")}`)
        }
      }
    );
    let result: CommitResult;
    try {
      result = await this.#dependencies.store.commit({
        idempotency,
        appends: decision.appends,
        jobs: decision.jobs
      });
    } catch (error) {
      const concurrentReplay = await this.#dependencies.store.readCommitResult(idempotency);
      if (concurrentReplay === null) throw error;
      return this.#createResponse(request, concurrentReplay);
    }
    return this.#createResponse(request, result);
  }

  #createResponse(input: CreateRunRequestInput, result: CommitResult): CreateRunResponse {
    const workItemEvent = result.events.find((event) => event.type === "work_item.created");
    const runEvent = result.events.find((event) => event.type === "run.created");
    if (workItemEvent?.type !== "work_item.created" || runEvent?.type !== "run.created") {
      throw new Error("A create-run commit did not return its creation events.");
    }

    const storedIntent = {
      title: workItemEvent.payload.workItem.title,
      description: workItemEvent.payload.workItem.description,
      acceptanceContext: workItemEvent.payload.workItem.acceptanceContext
    };
    const requestedIntent = CreateRunRequestSchema.parse(input);
    if (canonicalJson(storedIntent) !== canonicalJson(requestedIntent)) {
      throw new IdempotencyConflictError();
    }

    return CreateRunResponseSchema.parse({
      workItem: workItemEvent.payload.workItem,
      run: runEvent.payload.run,
      replayed: result.replayed
    });
  }

  async list(beforeGlobalSequence?: number): Promise<ListRunsResponse> {
    return ListRunsResponseSchema.parse(
      await this.#dependencies.store.listRunSummaries({
        workspaceId: this.#dependencies.workspaceId,
        limit: 100,
        ...(beforeGlobalSequence === undefined ? {} : { beforeGlobalSequence })
      })
    );
  }

  async events(runIdInput: string, afterSequence: number): Promise<ListEventsResponse> {
    const runId: RunId = RunIdSchema.parse(runIdInput);
    if (
      !(await this.#dependencies.store.runExists({
        workspaceId: this.#dependencies.workspaceId,
        runId
      }))
    ) {
      throw new RunNotFoundError(runId);
    }
    const events = await this.#dependencies.store.readRunEvents({
      workspaceId: this.#dependencies.workspaceId,
      runId,
      afterGlobalSequence: afterSequence,
      limit: 100
    });

    return ListEventsResponseSchema.parse({
      events,
      nextSequence: events.at(-1)?.globalSequence ?? afterSequence
    });
  }
}
