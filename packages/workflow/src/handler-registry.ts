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
    return registered.execute(payload, context);
  }
}
