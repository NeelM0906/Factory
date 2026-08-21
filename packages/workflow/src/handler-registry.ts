import { WorkflowHandlerResultSchema, normalizeSafeJson } from "@autostack/contracts";
import type { LeasedWorkflowJob, NewWorkflowJob, StreamAppend } from "@autostack/domain";
import type { z } from "zod";

import { DuplicateWorkflowHandlerError, UnknownWorkflowHandlerError } from "./errors.js";

export interface WorkflowHandlerContext {
  readonly job: LeasedWorkflowJob;
  readonly signal: AbortSignal;
}

export interface WorkflowHandlerResult {
  readonly appends: readonly StreamAppend[];
  readonly jobs: readonly NewWorkflowJob[];
}

export type WorkflowHandler<T> = (
  input: T,
  context: WorkflowHandlerContext
) => Promise<WorkflowHandlerResult>;

interface RegisteredHandler {
  execute(payload: unknown, context: WorkflowHandlerContext): Promise<WorkflowHandlerResult>;
}

export class HandlerRegistry {
  readonly #handlers = new Map<string, RegisteredHandler>();
  readonly #sensitiveValues: readonly string[];

  constructor(options: { readonly sensitiveValues?: readonly string[] } = {}) {
    this.#sensitiveValues = options.sensitiveValues ?? [];
  }

  register<T>(name: string, schema: z.ZodType<T>, handler: WorkflowHandler<T>): void {
    if (this.#handlers.has(name)) throw new DuplicateWorkflowHandlerError(name);
    this.#handlers.set(name, {
      execute: async (payload, context) => handler(schema.parse(payload), context)
    });
  }

  async execute(
    name: string,
    payload: unknown,
    context: WorkflowHandlerContext
  ): Promise<WorkflowHandlerResult> {
    const registered = this.#handlers.get(name);
    if (registered === undefined) throw new UnknownWorkflowHandlerError(name);
    const result = await registered.execute(payload, context);
    const snapshot = normalizeSafeJson(result, this.#sensitiveValues);
    const validated = WorkflowHandlerResultSchema.parse(snapshot);
    for (const append of validated.appends) {
      if (append.stream.kind === "run" && append.stream.id !== context.job.runId) {
        throw new TypeError("A handler append must match its leased run.");
      }
      if (append.events.some((event) => event.workspaceId !== context.job.workspaceId)) {
        throw new TypeError("A handler append must match its leased workspace.");
      }
      for (const event of append.events) {
        if (
          (event.type === "stage.queued" ||
            event.type === "stage.leased" ||
            event.type === "stage.succeeded" ||
            event.type === "stage.failed") &&
          (append.stream.kind !== "run" ||
            append.stream.id !== context.job.runId ||
            event.payload.runId !== context.job.runId ||
            event.payload.jobId !== context.job.jobId ||
            event.payload.stage !== context.job.stage)
        ) {
          throw new TypeError("Stage evidence must match its leased run, job, and stage.");
        }
      }
    }
    for (const job of validated.jobs) {
      if (job.workspaceId !== context.job.workspaceId || job.runId !== context.job.runId) {
        throw new TypeError("A child workflow job must match its parent workspace and run.");
      }
    }
    return validated;
  }
}
