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
  CommandAuthorizationSchema,
  ArtifactDescriptorSchema,
  DisposeEnvironmentRequestSchema,
  DisposeEnvironmentResponseSchema,
  EnvironmentAuthorizationSchema,
  InspectRepositoryRequestSchema,
  ListEnvironmentsResponseSchema,
  PreparedEnvironmentSchema,
  PrepareEnvironmentRequestSchema,
  ReadArtifactChunkResponseSchema,
  ReadCommandEventsRequestSchema,
  RepositoryInspectionSchema,
  RunnerCapabilitiesSchema,
  RunnerSubscriptionItemSchema,
  StartCommandRequestSchema,
  TerminalRunEvidenceSchema,
  type CommandAuthorization,
  type EnvironmentAuthorization,
  type TrustedRunnerAdmissionDependencies
} from "./runner.js";
import {
  admitPrepareEnvironment,
  admitStartCommand,
  digestCommandAuthorization,
  digestEnvironmentAuthorization,
  validateArtifactChunkResponse
} from "./runner.js";
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
export const HostPrepareEnvironmentResponseSchema = z
  .object({ environment: PreparedEnvironmentSchema, replayed: z.boolean() })
  .strict();

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
    response: HostPrepareEnvironmentResponseSchema
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
    mediaType: "application/json",
    response: HostArtifactContentResponseSchema
  },
  "DELETE /v1/environments/:environmentId": {
    successStatus: 200,
    mediaType: "application/json",
    response: DisposeEnvironmentResponseSchema
  }
} as const;

export interface TrustedHostAdmissionDependencies extends TrustedRunnerAdmissionDependencies {
  readonly now: () => string;
  readonly resolvePreparedEnvironment: (environmentId: string) => Promise<unknown>;
  readonly resolveArtifact: (artifactId: string) => Promise<unknown>;
  readonly resolveTerminalRunEvidence: (workspaceId: string, runId: string) => Promise<unknown>;
  readonly hasActiveCommand: (environmentId: string) => Promise<boolean>;
}

const requireTrustedEnvironmentAuthorization = async (
  request: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly environmentId: string;
    readonly environmentAuthorizationId: string;
    readonly environmentAuthorizationDigest: string;
  },
  dependencies: TrustedHostAdmissionDependencies
): Promise<EnvironmentAuthorization> => {
  const candidate = await dependencies.resolveEnvironmentAuthorization(
    request.environmentAuthorizationId
  );
  if (candidate === undefined)
    throw new TypeError("Recorded environment authorization is required.");
  const authorization = EnvironmentAuthorizationSchema.parse(normalizeSafeJson(candidate));
  if (
    authorization.id !== request.environmentAuthorizationId ||
    authorization.digest !== request.environmentAuthorizationDigest ||
    authorization.digest !== (await digestEnvironmentAuthorization(authorization)) ||
    authorization.scope.workspaceId !== request.workspaceId ||
    authorization.scope.runId !== request.runId ||
    authorization.scope.environmentId !== request.environmentId
  ) {
    throw new TypeError("Recorded environment authorization does not own this request.");
  }
  return authorization;
};

const requireTrustedCommandAuthorization = async (
  request: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly environmentId: string;
    readonly commandId: string;
    readonly environmentAuthorizationId: string;
    readonly environmentAuthorizationDigest: string;
    readonly commandAuthorizationId: string;
    readonly commandAuthorizationDigest: string;
  },
  dependencies: TrustedHostAdmissionDependencies
): Promise<CommandAuthorization> => {
  await requireTrustedEnvironmentAuthorization(request, dependencies);
  const candidate = await dependencies.resolveCommandAuthorization(request.commandAuthorizationId);
  if (candidate === undefined) throw new TypeError("Recorded command authorization is required.");
  const authorization = CommandAuthorizationSchema.parse(normalizeSafeJson(candidate));
  if (
    authorization.id !== request.commandAuthorizationId ||
    authorization.digest !== request.commandAuthorizationDigest ||
    authorization.digest !== (await digestCommandAuthorization(authorization)) ||
    authorization.scope.environmentAuthorizationId !== request.environmentAuthorizationId ||
    authorization.scope.environmentAuthorizationDigest !== request.environmentAuthorizationDigest ||
    authorization.scope.workspaceId !== request.workspaceId ||
    authorization.scope.runId !== request.runId ||
    authorization.scope.environmentId !== request.environmentId ||
    authorization.scope.commandId !== request.commandId
  ) {
    throw new TypeError("Recorded command authorization does not own this request.");
  }
  return authorization;
};

export const admitHostOperation = async (
  candidate: unknown,
  dependencies: TrustedHostAdmissionDependencies
): Promise<HostRouteRequest> => {
  const request = HostRouteRequestSchema.parse(normalizeSafeJson(candidate));
  if (request.route === "POST /v1/environments") {
    await admitPrepareEnvironment(request.body, dependencies.now(), dependencies);
  }
  if (request.route === "POST /v1/environments/:environmentId/commands") {
    await admitStartCommand(request.body, dependencies.now(), dependencies);
  }
  if (
    request.route === "GET /v1/environments/:environmentId/commands/:commandId/events" ||
    request.route === "POST /v1/environments/:environmentId/commands/:commandId/cancel"
  ) {
    await requireTrustedCommandAuthorization(
      request.route === "GET /v1/environments/:environmentId/commands/:commandId/events"
        ? request.query
        : request.body,
      dependencies
    );
  }
  if (request.route === "GET /v1/artifacts/:artifactId/content") {
    await requireTrustedCommandAuthorization(request.query, dependencies);
    const artifact = ArtifactDescriptorSchema.parse(
      normalizeSafeJson(await dependencies.resolveArtifact(request.artifactId))
    );
    if (
      artifact.artifactId !== request.artifactId ||
      artifact.workspaceId !== request.query.workspaceId ||
      artifact.runId !== request.query.runId ||
      artifact.commandId !== request.query.commandId
    ) {
      throw new TypeError("Recorded artifact does not own this request.");
    }
  }
  if (request.route === "DELETE /v1/environments/:environmentId") {
    await requireTrustedEnvironmentAuthorization(request.body, dependencies);
    const prepared = PreparedEnvironmentSchema.parse(
      normalizeSafeJson(await dependencies.resolvePreparedEnvironment(request.environmentId))
    );
    const evidence = TerminalRunEvidenceSchema.parse(
      normalizeSafeJson(
        await dependencies.resolveTerminalRunEvidence(request.body.workspaceId, request.body.runId)
      )
    );
    if (
      prepared.environmentId !== request.body.environmentId ||
      prepared.workspaceId !== request.body.workspaceId ||
      prepared.runId !== request.body.runId ||
      prepared.authorization.id !== request.body.environmentAuthorizationId ||
      prepared.authorization.digest !== request.body.environmentAuthorizationDigest ||
      evidence.status !== request.body.terminalRunEvidence.status ||
      evidence.terminalEventSequence !== request.body.terminalRunEvidence.terminalEventSequence ||
      evidence.terminalEventDigest !== request.body.terminalRunEvidence.terminalEventDigest ||
      (await dependencies.hasActiveCommand(request.body.environmentId))
    ) {
      throw new TypeError("Environment disposal lacks authoritative terminal evidence.");
    }
  }
  return request;
};

export const admitHostResponse = (
  requestCandidate: unknown,
  responseCandidate: unknown
): unknown => {
  const request = HostRouteRequestSchema.parse(normalizeSafeJson(requestCandidate));
  const response = z
    .object({ status: z.number().int(), mediaType: z.string(), body: z.unknown() })
    .strict()
    .parse(normalizeSafeJson(responseCandidate));
  const contract = HOST_ROUTE_CONTRACTS[request.route];
  if (response.status !== contract.successStatus || response.mediaType !== contract.mediaType) {
    throw new TypeError("Host response status or media type is invalid.");
  }
  switch (request.route) {
    case "GET /v1/health":
      return HostHealthResponseSchema.parse(response.body);
    case "GET /v1/environments":
      return ListEnvironmentsResponseSchema.parse(response.body);
    case "POST /v1/repositories/inspect":
      return RepositoryInspectionSchema.parse(response.body);
    case "POST /v1/environments": {
      const body = HostPrepareEnvironmentResponseSchema.parse(response.body);
      if (
        body.environment.environmentId !== request.body.environmentId ||
        body.environment.workspaceId !== request.body.workspaceId ||
        body.environment.runId !== request.body.runId ||
        body.environment.authorization.id !== request.body.authorization.id ||
        body.environment.authorization.digest !== request.body.authorization.digest
      ) {
        throw new TypeError("Prepared environment response does not match request.");
      }
      return body;
    }
    case "POST /v1/environments/:environmentId/commands": {
      const body = CommandAcceptedSchema.parse(response.body);
      if (body.commandId !== request.body.commandId) {
        throw new TypeError("Command response does not match request.");
      }
      return body;
    }
    case "GET /v1/environments/:environmentId/commands/:commandId/events":
      return HostCommandEventFrameSchema.parse(response.body);
    case "POST /v1/environments/:environmentId/commands/:commandId/cancel": {
      const body = CancelCommandResponseSchema.parse(response.body);
      if (body.commandId !== request.body.commandId) {
        throw new TypeError("Cancellation response does not match request.");
      }
      return body;
    }
    case "GET /v1/artifacts/:artifactId/content": {
      const body = HostArtifactContentResponseSchema.parse(response.body);
      const { range, ...authorization } = request.query;
      return validateArtifactChunkResponse(
        {
          ...authorization,
          artifactId: request.artifactId,
          offset: range.start,
          length: range.end - range.start + 1
        },
        body.chunk
      );
    }
    case "DELETE /v1/environments/:environmentId": {
      const body = DisposeEnvironmentResponseSchema.parse(response.body);
      if (body.environmentId !== request.body.environmentId) {
        throw new TypeError("Disposal response does not match request.");
      }
      return body;
    }
  }
};

export type HostApiRoute = z.infer<typeof HostApiRouteSchema>;
export type HostRouteRequest = z.infer<typeof HostRouteRequestSchema>;
export type HostError = z.infer<typeof HostErrorSchema>;
export type HostCommandEventFrame = z.infer<typeof HostCommandEventFrameSchema>;
export type HostArtifactContentRequest = z.infer<typeof HostArtifactContentRequestSchema>;
export type HostArtifactContentResponse = z.infer<typeof HostArtifactContentResponseSchema>;
