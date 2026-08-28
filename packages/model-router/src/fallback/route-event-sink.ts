import type { ModelRouteFallback } from "@autostack/contracts";

/**
 * Where `runWithFallback` records each fallback activation (spec §15). The contract audit's
 * deferral table makes appending domain event types an orchestrator-owned change, so this package
 * owns its own sink interface rather than reaching into `EVENT_TYPES`; Wave 2 (I1) wires it to
 * whatever durable surface exists then.
 */
export interface ModelRouteEventSink {
  record(event: ModelRouteFallback): Promise<void>;
}
