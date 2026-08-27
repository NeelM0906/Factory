import {
  ModelRouteFallbackSchema,
  ModelRoutingError,
  type ModelRouteContext
} from "@autostack/contracts";

import type { ModelRouteEventSink } from "./route-event-sink.js";

/**
 * One node in the ordered fallback chain: a route paired with the pinned model it targets. This
 * package is deliberately provider-independent, so a target carries only the two fields the
 * taxonomy and the contract's `ModelRouteFallbackSchema` need — never a prompt or response shape.
 */
export interface ModelRouteTarget {
  readonly routeRef: string;
  readonly model: string;
}

export interface RunWithFallbackInput<T> {
  /** The preferred target followed by the ordered fallback chain, already resolved by selection. */
  readonly order: readonly ModelRouteTarget[];
  readonly context: ModelRouteContext;
  /** Provider-independent: the caller supplies whatever a "call" means for it. */
  readonly attempt: (target: ModelRouteTarget, ordinal: number) => Promise<T>;
  readonly sink: ModelRouteEventSink;
  readonly now: () => string;
}

const isSameTarget = (a: ModelRouteTarget, b: ModelRouteTarget): boolean =>
  a.routeRef === b.routeRef && a.model === b.model;

/**
 * Mirrors `ModelRouteFallbackSchema`'s own refinement ("a fallback must change the route or the
 * model") so a degenerate order is rejected before any attempt runs, rather than discovered only
 * when the resulting record fails to parse after the provider call already happened.
 */
const assertNoNoOpFallback = (order: readonly ModelRouteTarget[]): void => {
  for (let index = 0; index < order.length - 1; index += 1) {
    const current = order[index];
    const next = order[index + 1];
    if (current !== undefined && next !== undefined && isSameTarget(current, next)) {
      throw new TypeError(
        `Adjacent fallback targets at index ${index} and ${index + 1} both resolve to route ` +
          `${current.routeRef} / model ${current.model}; a fallback must change the route or the model.`
      );
    }
  }
};

/**
 * Runs `attempt` against `order[0]`, and on a **retryable** `ModelRoutingError`, against each
 * subsequent target in order, recording one `ModelRouteFallback` per activation (spec §15). A
 * non-retryable failure does not advance — falling back after `budget_exceeded` or
 * `capability_unavailable` would spend money on a request the policy already refused. Exhausting
 * the order re-raises the last failure, preserving its code and retryability.
 */
export const runWithFallback = async <T>(input: RunWithFallbackInput<T>): Promise<T> => {
  const { order, context, attempt, sink, now } = input;

  if (order.length === 0) {
    throw new TypeError("runWithFallback requires at least one target in the order.");
  }

  assertNoNoOpFallback(order);

  for (let ordinal = 0; ordinal < order.length; ordinal += 1) {
    const target = order[ordinal];
    if (target === undefined) {
      // Unreachable: ordinal is bounded by order.length above.
      throw new TypeError("runWithFallback: ordinal out of range.");
    }

    try {
      return await attempt(target, ordinal);
    } catch (error) {
      if (!(error instanceof ModelRoutingError)) {
        throw error;
      }

      const nextTarget = order[ordinal + 1];
      const isLastTarget = nextTarget === undefined;
      if (!error.retryable || isLastTarget) {
        throw error;
      }

      const event = ModelRouteFallbackSchema.parse({
        schemaVersion: 1,
        idempotencyKey: context.idempotencyKey,
        workspaceId: context.workspaceId,
        runId: context.runId,
        stageRunId: context.stageRunId,
        from: target,
        to: nextTarget,
        failureCode: error.code,
        reason: error.message,
        occurredAt: now()
      });

      await sink.record(event);
    }
  }

  // Unreachable: the loop above always either returns or throws before falling through.
  throw new TypeError("runWithFallback: exhausted the order without a result or a failure.");
};
