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

export type ModelRoute = z.infer<typeof ModelRouteSchema>;
export type ModelRouteContext = z.infer<typeof ModelRouteContextSchema>;
export type ModelRouteSelection = z.infer<typeof ModelRouteSelectionSchema>;
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

/** Resolves routes and accounts for usage without coupling agent harnesses to a vendor SDK. */
export interface ModelRouterPort {
  resolve(context: ModelRouteContext): Promise<ModelRouteSelection>;
  getRoute(routeRef: string): Promise<ModelRoute | undefined>;
  recordUsage(usage: ModelUsage): Promise<void>;
}
