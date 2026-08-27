import { z } from "zod";

import { CredentialRefIdSchema, RunIdSchema, StageRunIdSchema, WorkspaceIdSchema } from "./ids.js";
import { SafeMetadataStringSchema } from "./secret-safety.js";

const VersionSchema = z.literal(1);
const TimestampSchema = z.iso.datetime();
const StableRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9._:/-]+$/);
const IdempotencyKeySchema = z.string().trim().min(1).max(240);

const VercelAiGatewayTransportSchema = z
  .object({
    kind: z.literal("vercel_ai_gateway"),
    gatewayModel: StableRefSchema,
    credentialRefId: CredentialRefIdSchema
  })
  .strict();

const OpenRouterTransportSchema = z
  .object({
    kind: z.literal("openrouter"),
    openRouterModel: StableRefSchema,
    credentialRefId: CredentialRefIdSchema
  })
  .strict();

const DirectEndpointSchema = z.url().refine((value) => {
  const parsed = new URL(value);
  return parsed.username === "" && parsed.password === "";
}, "Direct provider endpoints must not contain credentials.");

const DirectModelTransportSchema = z
  .object({
    kind: z.literal("direct"),
    protocol: z.enum(["openai_compatible", "anthropic", "google"]),
    provider: StableRefSchema,
    endpoint: DirectEndpointSchema,
    providerModel: StableRefSchema,
    credentialRefId: CredentialRefIdSchema
  })
  .strict();

export const ModelTransportSchema = z.discriminatedUnion("kind", [
  VercelAiGatewayTransportSchema,
  OpenRouterTransportSchema,
  DirectModelTransportSchema
]);

export const ModelRouteSchema = z
  .object({
    schemaVersion: VersionSchema,
    routeRef: StableRefSchema,
    displayName: SafeMetadataStringSchema.max(120),
    transport: ModelTransportSchema,
    enabled: z.boolean()
  })
  .strict();

export const ModelRouteContextSchema = z
  .object({
    schemaVersion: VersionSchema,
    idempotencyKey: IdempotencyKeySchema,
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    stageRunId: StageRunIdSchema,
    stage: z.enum(["triage", "plan", "implement", "verify", "isolated_review"]),
    requiredCapabilities: z.array(StableRefSchema).max(32).default([])
  })
  .strict();

export const ModelRouteSelectionSchema = z
  .object({
    schemaVersion: VersionSchema,
    idempotencyKey: IdempotencyKeySchema,
    routeRef: StableRefSchema,
    reason: SafeMetadataStringSchema.max(2_000),
    selectedAt: TimestampSchema
  })
  .strict();

export const ModelUsageSchema = z
  .object({
    schemaVersion: VersionSchema,
    idempotencyKey: IdempotencyKeySchema,
    routeRef: StableRefSchema,
    providerRequestId: StableRefSchema,
    provider: StableRefSchema,
    model: StableRefSchema,
    tokens: z
      .object({
        input: z.number().int().nonnegative(),
        output: z.number().int().nonnegative(),
        cachedInput: z.number().int().nonnegative().default(0),
        reasoning: z.number().int().nonnegative().default(0)
      })
      .strict(),
    cost: z.object({ currency: z.literal("USD"), micros: z.number().int().nonnegative() }).strict(),
    latencyMs: z.number().int().nonnegative(),
    recordedAt: TimestampSchema
  })
  .strict();

/** Reuses the station vocabulary already declared by `ModelRouteContextSchema`. */
const ModelStageSchema = ModelRouteContextSchema.shape.stage;

export const MODEL_MODALITIES = ["text", "image", "audio", "video", "pdf"] as const;
export const ModelModalitySchema = z.enum(MODEL_MODALITIES);

export const MODEL_FEATURES = [
  "tool_call",
  "structured_output",
  "streaming",
  "reasoning",
  "prompt_caching"
] as const;
export const ModelFeatureSchema = z.enum(MODEL_FEATURES);

const hasDuplicates = (values: readonly string[]): boolean =>
  new Set(values).size !== values.length;

/** Capability declaration discovered from a provider catalog (spec §10.1). */
export const ModelCatalogEntrySchema = z
  .object({
    schemaVersion: VersionSchema,
    routeRef: StableRefSchema,
    providerModel: StableRefSchema,
    displayName: SafeMetadataStringSchema.max(160),
    inputModalities: z.array(ModelModalitySchema).min(1).max(MODEL_MODALITIES.length),
    outputModalities: z.array(ModelModalitySchema).min(1).max(MODEL_MODALITIES.length),
    features: z.array(ModelFeatureSchema).max(MODEL_FEATURES.length),
    contextWindowTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    discoveredAt: TimestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    const declarations = [
      ["inputModalities", value.inputModalities],
      ["outputModalities", value.outputModalities],
      ["features", value.features]
    ] as const;
    for (const [path, values] of declarations) {
      if (hasDuplicates(values)) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: "A discovered capability may only be declared once."
        });
      }
    }
  });

/** A provider-reported measurement, or an explicit record that the provider reported nothing. */
export const ModelTokenCountSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("reported"), value: z.number().int().nonnegative() }).strict(),
  z.object({ state: z.literal("unknown") }).strict()
]);

export const ModelCostSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("reported"),
      currency: z.literal("USD"),
      micros: z.number().int().nonnegative()
    })
    .strict(),
  z.object({ state: z.literal("unknown") }).strict()
]);

export const ModelTokenUsageSchema = z
  .object({
    input: ModelTokenCountSchema,
    output: ModelTokenCountSchema,
    cachedInput: ModelTokenCountSchema,
    reasoning: ModelTokenCountSchema
  })
  .strict();

/** Attributed usage that keeps missing provider data unknown rather than estimated (spec §10.2). */
export const ModelUsageRecordSchema = z
  .object({
    schemaVersion: VersionSchema,
    idempotencyKey: IdempotencyKeySchema,
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    stageRunId: StageRunIdSchema,
    stage: ModelStageSchema,
    adapterId: StableRefSchema,
    routeRef: StableRefSchema,
    requested: z.object({ provider: StableRefSchema.optional(), model: StableRefSchema }).strict(),
    actual: z
      .object({
        provider: StableRefSchema,
        model: StableRefSchema,
        providerRequestId: StableRefSchema.optional()
      })
      .strict(),
    tokens: ModelTokenUsageSchema,
    cost: ModelCostSchema,
    latencyMs: z.number().int().nonnegative(),
    outcome: z.enum(["succeeded", "failed", "cancelled"]),
    /**
     * Orders the records a retried request produces. A router that falls back keeps one
     * `idempotencyKey` across attempts — the caller asked once — so without an ordinal the
     * per-attempt records would be indistinguishable and cost would be attributed to whichever
     * arrived last.
     */
    attempt: z.number().int().nonnegative().optional(),
    recordedAt: TimestampSchema
  })
  .strict();

const ModelRouteTargetSchema = z
  .object({ routeRef: StableRefSchema, model: StableRefSchema })
  .strict();

/**
 * The shared vocabulary for a route that could not be resolved (spec §8.3, §10.1). Every stream
 * that raises or classifies a routing failure uses these codes, so the retry decision is read from
 * the taxonomy rather than from provider prose.
 */
export const MODEL_ROUTING_FAILURE_CODES = [
  "capability_unavailable",
  "route_disabled",
  "provider_error",
  "rate_limited",
  "budget_exceeded"
] as const;
export const ModelRoutingFailureCodeSchema = z.enum(MODEL_ROUTING_FAILURE_CODES);

/** A provider or model fallback, recorded so cost and evaluation reflect reality (spec §15). */
export const ModelRouteFallbackSchema = z
  .object({
    schemaVersion: VersionSchema,
    idempotencyKey: IdempotencyKeySchema,
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    stageRunId: StageRunIdSchema,
    from: ModelRouteTargetSchema,
    to: ModelRouteTargetSchema,
    failureCode: ModelRoutingFailureCodeSchema,
    reason: SafeMetadataStringSchema.max(2_000),
    occurredAt: TimestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.from.routeRef === value.to.routeRef && value.from.model === value.to.model) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "A fallback must change the route or the model."
      });
    }
  });

/** Codes that describe the request itself, not the moment: retrying the same request cannot help. */
const DETERMINISTIC_ROUTING_FAILURE_CODES = new Set<ModelRoutingFailureCode>([
  "capability_unavailable",
  "route_disabled",
  "budget_exceeded"
]);

/** Codes that describe the moment, not the request: the same request can succeed later. */
const TRANSIENT_ROUTING_FAILURE_CODES = new Set<ModelRoutingFailureCode>(["rate_limited"]);

export const ModelRoutingFailureSchema = z
  .object({
    schemaVersion: VersionSchema,
    code: ModelRoutingFailureCodeSchema,
    message: SafeMetadataStringSchema.max(2_000),
    retryable: z.boolean(),
    routeRef: StableRefSchema.optional(),
    requestedModel: StableRefSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (DETERMINISTIC_ROUTING_FAILURE_CODES.has(value.code) && value.retryable) {
      context.addIssue({
        code: "custom",
        path: ["retryable"],
        message: `A ${value.code} failure describes the request, so retrying it cannot succeed.`
      });
    }
    if (TRANSIENT_ROUTING_FAILURE_CODES.has(value.code) && !value.retryable) {
      context.addIssue({
        code: "custom",
        path: ["retryable"],
        message: `A ${value.code} failure describes the moment, so it must stay retryable.`
      });
    }
  });

export type ModelRoutingFailureCode = z.infer<typeof ModelRoutingFailureCodeSchema>;
export type ModelRoutingFailure = z.infer<typeof ModelRoutingFailureSchema>;

/**
 * The throwable form of a routing failure. `ModelRouterPort.resolve` returns a selection or raises,
 * so the taxonomy has to survive as an error; admission happens in the constructor, which means an
 * unmodelled code can never reach a caller's retry decision.
 */
export class ModelRoutingError extends Error {
  readonly failure: ModelRoutingFailure;
  readonly code: ModelRoutingFailureCode;
  readonly retryable: boolean;

  constructor(failure: unknown) {
    const admitted = ModelRoutingFailureSchema.parse(failure);
    super(admitted.message);
    this.name = "ModelRoutingError";
    this.failure = admitted;
    this.code = admitted.code;
    this.retryable = admitted.retryable;
  }
}

export const MODEL_REASONING_LEVELS = ["none", "low", "medium", "high"] as const;
export const ModelReasoningLevelSchema = z.enum(MODEL_REASONING_LEVELS);

/** Per-station model constraints the pipeline enforces and the inspector displays (spec §10.2). */
export const ModelPolicySchema = z
  .object({
    schemaVersion: VersionSchema,
    policyRef: StableRefSchema,
    stage: ModelStageSchema,
    allowedRouteRefs: z.array(StableRefSchema).min(1).max(32),
    fallbackRouteRefs: z.array(StableRefSchema).max(32),
    maxInputTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    maxCostMicros: z.number().int().nonnegative().optional(),
    reasoningLevel: ModelReasoningLevelSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    for (const [path, routeRefs] of [
      ["allowedRouteRefs", value.allowedRouteRefs],
      ["fallbackRouteRefs", value.fallbackRouteRefs]
    ] as const) {
      if (hasDuplicates(routeRefs)) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: "A route may only be listed once."
        });
      }
    }
    const allowed = new Set(value.allowedRouteRefs);
    for (const [index, routeRef] of value.fallbackRouteRefs.entries()) {
      if (!allowed.has(routeRef)) {
        context.addIssue({
          code: "custom",
          path: ["fallbackRouteRefs", index],
          message: "A policy cannot fall back to a route it does not allow."
        });
      }
    }
  });

export type ModelRoute = z.infer<typeof ModelRouteSchema>;
export type ModelRouteContext = z.infer<typeof ModelRouteContextSchema>;
export type ModelRouteSelection = z.infer<typeof ModelRouteSelectionSchema>;
export type ModelUsage = z.infer<typeof ModelUsageSchema>;
export type ModelModality = z.infer<typeof ModelModalitySchema>;
export type ModelFeature = z.infer<typeof ModelFeatureSchema>;
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;
export type ModelTokenCount = z.infer<typeof ModelTokenCountSchema>;
export type ModelCost = z.infer<typeof ModelCostSchema>;
export type ModelTokenUsage = z.infer<typeof ModelTokenUsageSchema>;
export type ModelUsageRecord = z.infer<typeof ModelUsageRecordSchema>;
export type ModelRouteFallback = z.infer<typeof ModelRouteFallbackSchema>;
export type ModelReasoningLevel = z.infer<typeof ModelReasoningLevelSchema>;
export type ModelPolicy = z.infer<typeof ModelPolicySchema>;

/** Resolves routes and accounts for usage without coupling agent harnesses to a vendor SDK. */
export interface ModelRouterPort {
  resolve(context: ModelRouteContext): Promise<ModelRouteSelection>;
  getRoute(routeRef: string): Promise<ModelRoute | undefined>;
  recordUsage(usage: ModelUsage): Promise<void>;
}
