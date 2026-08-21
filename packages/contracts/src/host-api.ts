import { z } from "zod";

import {
  ArtifactIdSchema,
  CommandIdSchema,
  EnvironmentIdSchema,
  RunIdSchema,
  WorkspaceIdSchema
} from "./ids.js";
import {
  CancelCommandRequestSchema,
  CancelCommandResponseSchema,
  CommandAcceptedSchema,
  DisposeEnvironmentRequestSchema,
  DisposeEnvironmentResponseSchema,
  InspectRepositoryRequestSchema,
  ListEnvironmentsResponseSchema,
  PrepareEnvironmentRequestSchema,
  ReadArtifactChunkRequestSchema,
  ReadArtifactChunkResponseSchema,
  ReadCommandEventsRequestSchema,
  RepositoryInspectionSchema,
  RunnerSubscriptionItemSchema,
  StartCommandRequestSchema
} from "./runner.js";

export const HostApiRouteSchema = z.enum([
  "GET /v1/health",
  "GET /v1/environments",
  "POST /v1/repositories/inspect",
  "POST /v1/environments",
  "POST /v1/environments/:environmentId/commands",
  "GET /v1/environments/:environmentId/commands/:commandId/events",
  "POST /v1/environments/:environmentId/commands/:commandId/cancel",
  "GET /v1/artifacts/:artifactId/content",
  "DELETE /v1/environments/:environmentId"
]);

export const HostErrorCodeSchema = z.enum([
  "unauthorized",
  "invalid_request",
  "request_too_large",
  "not_found",
  "idempotency_conflict",
  "scope_mismatch",
  "authorization_invalid",
  "authorization_expired",
  "unsupported_policy",
  "environment_not_prepared",
  "command_not_found",
  "artifact_not_found",
  "range_not_satisfiable",
  "environment_active",
  "internal_error"
]);
export const HostErrorSchema = z
  .object({
    error: z
      .object({
        code: HostErrorCodeSchema,
        message: z.string().min(1).max(2_000),
        details: z.record(z.string(), z.unknown()).optional()
      })
      .strict(),
    requestId: z.string().min(1).max(256).optional()
  })
  .strict();

export const HostHealthResponseSchema = z
  .object({
    service: z.literal("autostack-host-daemon"),
    version: z.string().min(1),
    status: z.enum(["ok", "degraded"])
  })
  .strict();
export const HostCommandEventFrameSchema = RunnerSubscriptionItemSchema;
export const HostCommandEventsRequestSchema = ReadCommandEventsRequestSchema;
export const HostArtifactContentRequestSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    range: z
      .object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })
      .strict()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.range.end < value.range.start ||
      value.range.end - value.range.start + 1 > 1_048_576
    ) {
      context.addIssue({
        code: "custom",
        path: ["range"],
        message: "A single bounded byte range is required."
      });
    }
  });
export const HostArtifactContentResponseSchema = z
  .object({ contentType: z.string().min(1).max(255), chunk: ReadArtifactChunkResponseSchema })
  .strict();

export const HostRouteRequestSchema = z.discriminatedUnion("route", [
  z.object({ route: z.literal("GET /v1/health") }).strict(),
  z.object({ route: z.literal("GET /v1/environments") }).strict(),
  z
    .object({
      route: z.literal("POST /v1/repositories/inspect"),
      body: InspectRepositoryRequestSchema
    })
    .strict(),
  z
    .object({ route: z.literal("POST /v1/environments"), body: PrepareEnvironmentRequestSchema })
    .strict(),
  z
    .object({
      route: z.literal("POST /v1/environments/:environmentId/commands"),
      environmentId: EnvironmentIdSchema,
      body: StartCommandRequestSchema
    })
    .strict(),
  z
    .object({
      route: z.literal("GET /v1/environments/:environmentId/commands/:commandId/events"),
      environmentId: EnvironmentIdSchema,
      commandId: CommandIdSchema,
      query: HostCommandEventsRequestSchema
    })
    .strict(),
  z
    .object({
      route: z.literal("POST /v1/environments/:environmentId/commands/:commandId/cancel"),
      environmentId: EnvironmentIdSchema,
      commandId: CommandIdSchema,
      body: CancelCommandRequestSchema
    })
    .strict(),
  z
    .object({
      route: z.literal("GET /v1/artifacts/:artifactId/content"),
      body: HostArtifactContentRequestSchema
    })
    .strict(),
  z
    .object({
      route: z.literal("DELETE /v1/environments/:environmentId"),
      environmentId: EnvironmentIdSchema,
      body: DisposeEnvironmentRequestSchema
    })
    .strict()
]);

export const HostRouteResponseSchema = z.union([
  HostHealthResponseSchema,
  ListEnvironmentsResponseSchema,
  RepositoryInspectionSchema,
  CommandAcceptedSchema,
  CancelCommandResponseSchema,
  DisposeEnvironmentResponseSchema,
  HostArtifactContentResponseSchema,
  HostErrorSchema
]);

export const HostArtifactChunkRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    request: ReadArtifactChunkRequestSchema
  })
  .strict();

export type HostApiRoute = z.infer<typeof HostApiRouteSchema>;
export type HostError = z.infer<typeof HostErrorSchema>;
export type HostCommandEventFrame = z.infer<typeof HostCommandEventFrameSchema>;
export type HostArtifactContentRequest = z.infer<typeof HostArtifactContentRequestSchema>;
export type HostArtifactContentResponse = z.infer<typeof HostArtifactContentResponseSchema>;
