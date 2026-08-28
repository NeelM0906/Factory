import {
  ModelUsageRecordSchema,
  type ModelCost,
  type ModelRouteContext,
  type ModelTokenCount,
  type ModelUsageRecord
} from "@autostack/contracts";

import type { RoutePricing } from "../catalog/catalog-types.js";

/**
 * Raw, provider-reported usage for one attempt. Untrusted (spec §14.1): any named count may be
 * absent, the wrong type, negative, or non-integer, and the object may carry arbitrary extra keys —
 * including ones that collide with attribution field names such as `workspaceId` or `routeRef`.
 * `normalizeUsage` never reads attribution from this object; every attribution field comes from
 * `context`/`routeRef` (the request), never from the provider response (spec §10.2).
 */
export interface ProviderReportedUsage {
  readonly [key: string]: unknown;
}

/** What was originally asked for. May differ from `actual` after a fallback (spec §15). */
export interface NormalizeUsageRequested {
  readonly provider?: string;
  readonly model: string;
}

/** What the provider actually served, and the id it billed under, if any. */
export interface NormalizeUsageActual {
  readonly provider: string;
  readonly model: string;
  readonly providerRequestId?: string;
}

export type ModelUsageOutcome = "succeeded" | "failed" | "cancelled";

export interface NormalizeUsageInput {
  /** Attribution source: `workspaceId`, `runId`, `stageRunId`, `stage`, `idempotencyKey`. */
  readonly context: ModelRouteContext;
  /** The resolved route this attempt ran against — also from the request, never the provider. */
  readonly routeRef: string;
  readonly adapterId: string;
  /** Zero-based ordinal distinguishing attempts sharing one `idempotencyKey` (DEC-4). */
  readonly attempt: number;
  readonly requested: NormalizeUsageRequested;
  readonly actual: NormalizeUsageActual;
  /** Untrusted; a missing or malformed count becomes `unknown`, never a coerced `0`. */
  readonly providerUsage: ProviderReportedUsage;
  /**
   * The route's pricing, when known. Used only to derive `cost` from *reported* token counts —
   * never from an `unknown` one, which would be estimating (DEC-2). Absent for providers that
   * publish no pricing.
   */
  readonly pricing?: RoutePricing;
  readonly latencyMs: number;
  readonly outcome: ModelUsageOutcome;
  readonly now: () => string;
}

const toTokenCount = (raw: unknown): ModelTokenCount => {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) {
    return { state: "reported", value: raw };
  }
  return { state: "unknown" };
};

const toReportedCostMicros = (raw: unknown): number | undefined => {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) {
    return raw;
  }
  return undefined;
};

/**
 * Cost is a worst-case-free *exact* figure here (unlike DEC-2's policy-time worst case): both
 * directions must be `reported` token counts, priced from the route's declared per-token rates and
 * rounded to the nearest micro-dollar. Either direction being `unknown`, or pricing being absent,
 * means no cost can be proven — deriving one anyway would be the estimate spec §10.2 forbids.
 */
const deriveCostFromPricing = (
  input: ModelTokenCount,
  output: ModelTokenCount,
  pricing: RoutePricing | undefined
): number | undefined => {
  if (pricing === undefined || input.state !== "reported" || output.state !== "reported") {
    return undefined;
  }
  const usd = input.value * pricing.inputUsdPerToken + output.value * pricing.outputUsdPerToken;
  return Math.round(usd * 1_000_000);
};

const resolveCost = (
  providerUsage: ProviderReportedUsage,
  tokens: { readonly input: ModelTokenCount; readonly output: ModelTokenCount },
  pricing: RoutePricing | undefined
): ModelCost => {
  const reportedMicros = toReportedCostMicros(providerUsage["costMicros"]);
  if (reportedMicros !== undefined) {
    return { state: "reported", currency: "USD", micros: reportedMicros };
  }
  const derivedMicros = deriveCostFromPricing(tokens.input, tokens.output, pricing);
  if (derivedMicros !== undefined) {
    return { state: "reported", currency: "USD", micros: derivedMicros };
  }
  return { state: "unknown" };
};

/**
 * Normalizes one provider attempt into a `ModelUsageRecord` that keeps missing provider data
 * `unknown` rather than estimating it (spec §10.2). Attribution — `workspaceId`, `runId`,
 * `stageRunId`, `stage`, `routeRef`, `idempotencyKey` — is taken exclusively from `context` and
 * `routeRef`, never from `providerUsage`, so a provider response can never attribute cost to
 * another run. Called once per attempt (DEC-4): a fallback chain of N attempts under one
 * `idempotencyKey` calls this N times with `attempt` 0..N-1, and a failed attempt still produces a
 * record with `outcome: "failed"` so billed cost is never dropped.
 */
export const normalizeUsage = (input: NormalizeUsageInput): ModelUsageRecord => {
  const {
    context,
    routeRef,
    adapterId,
    attempt,
    requested,
    actual,
    providerUsage,
    pricing,
    latencyMs,
    outcome,
    now
  } = input;

  const tokens = {
    input: toTokenCount(providerUsage["inputTokens"]),
    output: toTokenCount(providerUsage["outputTokens"]),
    cachedInput: toTokenCount(providerUsage["cachedInputTokens"]),
    reasoning: toTokenCount(providerUsage["reasoningTokens"])
  };

  return ModelUsageRecordSchema.parse({
    schemaVersion: 1,
    idempotencyKey: context.idempotencyKey,
    workspaceId: context.workspaceId,
    runId: context.runId,
    stageRunId: context.stageRunId,
    stage: context.stage,
    adapterId,
    routeRef,
    requested,
    actual,
    tokens,
    cost: resolveCost(providerUsage, tokens, pricing),
    latencyMs,
    outcome,
    attempt,
    recordedAt: now()
  });
};
