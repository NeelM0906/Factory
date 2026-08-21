import { z } from "zod";

import {
  ArtifactIdSchema,
  CommandAuthorizationIdSchema,
  CommandIdSchema,
  EnvironmentAuthorizationIdSchema,
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
  ReadArtifactChunkResponseSchema,
  ReadCommandEventsRequestSchema,
  RepositoryInspectionSchema,
  RunnerCapabilitiesSchema,
  RunnerSubscriptionItemSchema,
  StartCommandRequestSchema
} from "./runner.js";
import { admitPrepareEnvironment, admitStartCommand } from "./runner.js";
import {
  containsSensitiveMaterial,
  normalizeSafeJson,
  SafeMetadataStringSchema
} from "./secret-safety.js";

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
const HostErrorDetailKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .refine(
    (value) => !containsSensitiveMaterial(value),
    "Sensitive error detail keys are forbidden."
  );
const HostErrorDetailValueSchema = z.union([
  z.boolean(),
  z.number().finite(),
  SafeMetadataStringSchema.max(256)
]);
const HostErrorDetailsSchema = z
  .record(HostErrorDetailKeySchema, HostErrorDetailValueSchema)
  .superRefine((value, context) => {
    if (Object.keys(value).length > 10) {
      context.addIssue({ code: "custom", message: "Too many error details." });
    }
  });
export const HostErrorSchema = z
  .object({
    error: z
      .object({
        code: HostErrorCodeSchema,
        message: SafeMetadataStringSchema.max(512),
        details: HostErrorDetailsSchema.optional()
      })
      .strict(),
    requestId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .optional()
  })
  .strict();

export const HostHealthResponseSchema = z
  .object({
    service: z.literal("autostack-host-daemon"),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    status: z.enum(["ok", "degraded"]),
    capabilities: RunnerCapabilitiesSchema
  })
  .strict();
export const HostCommandEventFrameSchema = RunnerSubscriptionItemSchema;
export const HostCommandEventsRequestSchema = ReadCommandEventsRequestSchema;
export const HostArtifactRangeSchema = z
  .object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })
  .strict()
  .superRefine((value, context) => {
    if (value.end < value.start || value.end - value.start + 1 > 1_048_576) {
      context.addIssue({ code: "custom", message: "A single bounded byte range is required." });
    }
  });
export const HostArtifactContentRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    environmentId: EnvironmentIdSchema,
    commandId: CommandIdSchema,
    environmentAuthorizationId: EnvironmentAuthorizationIdSchema,
    environmentAuthorizationDigest: z.string().regex(/^[0-9a-f]{64}$/),
    commandAuthorizationId: CommandAuthorizationIdSchema,
    commandAuthorizationDigest: z.string().regex(/^[0-9a-f]{64}$/),
    range: HostArtifactRangeSchema
  })
  .strict();
export const HostArtifactContentResponseSchema = z
  .object({
    contentType: z.string().regex(/^[a-z]+\/[a-z0-9!#$&^_.+-]+(?:; charset=[A-Za-z0-9._-]+)?$/),
    chunk: ReadArtifactChunkResponseSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.contentType !== value.chunk.artifact.mediaType) {
      context.addIssue({
        code: "custom",
        message: "Artifact content type must match its descriptor."
      });
    }
  });

const commandPathMatches = (
  environmentId: string,
  commandId: string,
  request: { environmentId: string; commandId: string }
): boolean => request.environmentId === environmentId && request.commandId === commandId;

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
    .strict()
    .superRefine((value, context) => {
      if (value.environmentId !== value.body.environmentId) {
        context.addIssue({
          code: "custom",
          message: "Route and command environment identities differ."
        });
      }
    }),
  z
    .object({
      route: z.literal("GET /v1/environments/:environmentId/commands/:commandId/events"),
      environmentId: EnvironmentIdSchema,
      commandId: CommandIdSchema,
      query: HostCommandEventsRequestSchema
    })
    .strict()
    .superRefine((value, context) => {
      if (!commandPathMatches(value.environmentId, value.commandId, value.query)) {
        context.addIssue({ code: "custom", message: "Route and event query identities differ." });
      }
    }),
  z
    .object({
      route: z.literal("POST /v1/environments/:environmentId/commands/:commandId/cancel"),
      environmentId: EnvironmentIdSchema,
      commandId: CommandIdSchema,
      body: CancelCommandRequestSchema
    })
    .strict()
    .superRefine((value, context) => {
      if (!commandPathMatches(value.environmentId, value.commandId, value.body)) {
        context.addIssue({ code: "custom", message: "Route and cancellation identities differ." });
      }
    }),
  z
    .object({
      route: z.literal("GET /v1/artifacts/:artifactId/content"),
      artifactId: ArtifactIdSchema,
      query: HostArtifactContentRequestSchema
    })
    .strict(),
  z
    .object({
      route: z.literal("DELETE /v1/environments/:environmentId"),
      environmentId: EnvironmentIdSchema,
      body: DisposeEnvironmentRequestSchema
    })
    .strict()
    .superRefine((value, context) => {
      if (value.environmentId !== value.body.environmentId) {
        context.addIssue({
          code: "custom",
          message: "Route and disposal environment identities differ."
        });
      }
    })
]);

export const HOST_ROUTE_CONTRACTS = {
  "GET /v1/health": {
    successStatus: 200,
    mediaType: "application/json",
    response: HostHealthResponseSchema
  },
  "GET /v1/environments": {
    successStatus: 200,
    mediaType: "application/json",
    response: ListEnvironmentsResponseSchema
  },
  "POST /v1/repositories/inspect": {
    successStatus: 200,
    mediaType: "application/json",
    response: RepositoryInspectionSchema
  },
  "POST /v1/environments": {
    successStatus: 202,
    mediaType: "application/json",
    response: z.object({ environmentId: EnvironmentIdSchema }).strict()
  },
  "POST /v1/environments/:environmentId/commands": {
    successStatus: 202,
    mediaType: "application/json",
    response: CommandAcceptedSchema
  },
  "GET /v1/environments/:environmentId/commands/:commandId/events": {
    successStatus: 200,
    mediaType: "application/x-ndjson",
    response: HostCommandEventFrameSchema
  },
  "POST /v1/environments/:environmentId/commands/:commandId/cancel": {
    successStatus: 200,
    mediaType: "application/json",
    response: CancelCommandResponseSchema
  },
  "GET /v1/artifacts/:artifactId/content": {
    successStatus: 206,
    mediaType: "artifact-descriptor",
    response: HostArtifactContentResponseSchema
  },
  "DELETE /v1/environments/:environmentId": {
    successStatus: 200,
    mediaType: "application/json",
    response: DisposeEnvironmentResponseSchema
  }
} as const;

export const admitHostOperation = async (
  candidate: unknown,
  now: unknown,
  environmentAuthorization?: unknown
): Promise<HostRouteRequest> => {
  const request = HostRouteRequestSchema.parse(normalizeSafeJson(candidate));
  if (request.route === "POST /v1/environments") {
    await admitPrepareEnvironment(request.body, now);
  }
  if (request.route === "POST /v1/environments/:environmentId/commands") {
    if (environmentAuthorization === undefined) {
      throw new TypeError("A recorded environment authorization is required to start a command.");
    }
    await admitStartCommand(request.body, environmentAuthorization, now);
  }
  return request;
};

export type HostApiRoute = z.infer<typeof HostApiRouteSchema>;
export type HostRouteRequest = z.infer<typeof HostRouteRequestSchema>;
export type HostError = z.infer<typeof HostErrorSchema>;
export type HostCommandEventFrame = z.infer<typeof HostCommandEventFrameSchema>;
export type HostArtifactContentRequest = z.infer<typeof HostArtifactContentRequestSchema>;
export type HostArtifactContentResponse = z.infer<typeof HostArtifactContentResponseSchema>;
