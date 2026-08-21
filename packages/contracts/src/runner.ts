import { z } from "zod";

import {
  ApprovalIdSchema,
  ArtifactIdSchema,
  CommandAuthorizationIdSchema,
  CommandIdSchema,
  CredentialRefIdSchema,
  EnvironmentAuthorizationIdSchema,
  EnvironmentIdSchema,
  RunIdSchema,
  WorkspaceIdSchema
} from "./ids.js";
import {
  normalizeSafeJson,
  SafeMetadataStringSchema,
  type SafeJsonValue
} from "./secret-safety.js";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/i);
const CommitSchema = z.string().regex(/^[0-9a-f]{40}$/i);
const TimestampSchema = z.iso.datetime();
const ByteCountSchema = z.number().int().nonnegative();
const PositiveSequenceSchema = z.number().int().positive();
const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(8_192)
  .refine(
    (value) => value.startsWith("/") && !value.includes("\u0000"),
    "An absolute POSIX path without NUL bytes is required."
  );

export const RelativeWorkspacePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .superRefine((value, context) => {
    if (value === ".") return;
    if (
      value.includes("\u0000") ||
      value.startsWith("/") ||
      value.startsWith("\\") ||
      value.includes("\\") ||
      /^[A-Za-z]:/.test(value)
    ) {
      context.addIssue({ code: "custom", message: "A relative POSIX workspace path is required." });
      return;
    }
    const segments = value.split("/");
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
      context.addIssue({
        code: "custom",
        message: "Workspace paths cannot contain traversal segments."
      });
    }
  });

const EnvironmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
export const CommandEnvironmentEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("literal"),
      name: EnvironmentNameSchema,
      value: SafeMetadataStringSchema.max(8_192)
    })
    .strict(),
  z
    .object({
      kind: z.literal("credential_ref"),
      name: EnvironmentNameSchema,
      credentialRefId: CredentialRefIdSchema
    })
    .strict()
]);

export const CommandSpecSchema = z
  .object({
    executable: z.string().trim().min(1).max(1_024),
    args: z.array(z.string().max(8_192)).max(256),
    cwd: RelativeWorkspacePathSchema.default("."),
    environment: z.array(CommandEnvironmentEntrySchema).max(128),
    timeoutSeconds: z.number().int().min(1).max(14_400),
    terminal: z
      .object({
        columns: z.number().int().min(20).max(500),
        rows: z.number().int().min(5).max(300)
      })
      .strict()
  })
  .strict();

export const NetworkPolicySchema = z.enum(["host", "none", "restricted"]);
export const ResourceLimitsSchema = z
  .object({
    cpu: z.number().positive(),
    memoryMb: z.number().int().positive(),
    durationSeconds: z.number().int().positive()
  })
  .strict();

const EnforcementSchema = z.enum(["hard", "advisory", "unavailable"]);
export const RunnerCapabilitiesSchema = z
  .object({
    runnerId: z.string().trim().min(1).max(120),
    version: z.string().trim().min(1).max(120),
    platform: z.object({ os: z.literal("darwin"), architecture: z.literal("arm64") }).strict(),
    pty: z.literal(true),
    cancellation: z.literal(true),
    maximumBytes: z
      .object({
        liveOutput: ByteCountSchema.positive(),
        replay: ByteCountSchema.positive(),
        transcript: ByteCountSchema.positive(),
        artifact: ByteCountSchema.positive()
      })
      .strict(),
    supportedNetworkPolicies: z.array(z.literal("host")).min(1).max(1),
    enforcement: z
      .object({
        cpu: EnforcementSchema,
        memory: EnforcementSchema,
        duration: EnforcementSchema,
        autostackPathOperations: EnforcementSchema,
        childFilesystem: EnforcementSchema,
        network: EnforcementSchema
      })
      .strict()
  })
  .strict();

export const InspectRepositoryRequestSchema = z
  .object({ sourcePath: AbsolutePathSchema, baseRef: SafeMetadataStringSchema.max(512) })
  .strict();
export const RepositoryInspectionSchema = z
  .object({
    repositoryIdentity: SafeMetadataStringSchema.max(1_024),
    canonicalSourcePath: AbsolutePathSchema,
    repositoryCommonDirectory: AbsolutePathSchema,
    remoteIdentity: SafeMetadataStringSchema.max(1_024).optional(),
    resolvedBaseRef: SafeMetadataStringSchema.max(512),
    sourceCommit: CommitSchema,
    dirty: z.boolean(),
    diagnostics: z.array(SafeMetadataStringSchema.max(2_000)).max(100)
  })
  .strict();

const ExecutionScopeShape = {
  workspaceId: WorkspaceIdSchema,
  runId: RunIdSchema,
  environmentId: EnvironmentIdSchema,
  repositoryIdentity: SafeMetadataStringSchema.max(1_024),
  sourceCommit: CommitSchema,
  branch: z.string().regex(/^autostack\/[A-Za-z0-9._/-]{1,240}$/),
  cwdRoot: RelativeWorkspacePathSchema,
  resourceLimits: ResourceLimitsSchema,
  networkPolicy: z.literal("host"),
  filesystemDisclosure: z.literal("host_user"),
  allowedCredentialRefIds: z.array(CredentialRefIdSchema).max(128)
} as const;
export const ExecutionScopeSchema = z.object(ExecutionScopeShape).strict();

const EnvironmentAuthorizationWithoutDigestSchema = z
  .object({
    id: EnvironmentAuthorizationIdSchema,
    approvalId: ApprovalIdSchema,
    approvalEvidenceDigest: Sha256Schema,
    scope: ExecutionScopeSchema,
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expiresAt <= value.createdAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Expiry must follow creation."
      });
    }
  });
export const EnvironmentAuthorizationSchema = EnvironmentAuthorizationWithoutDigestSchema.extend({
  digest: Sha256Schema
}).strict();
export const EnvironmentAuthorizationDigestInputSchema =
  EnvironmentAuthorizationWithoutDigestSchema;

const CommandScopeShape = {
  environmentAuthorizationId: EnvironmentAuthorizationIdSchema,
  environmentAuthorizationDigest: Sha256Schema,
  workspaceId: WorkspaceIdSchema,
  runId: RunIdSchema,
  environmentId: EnvironmentIdSchema,
  commandId: CommandIdSchema,
  action: z.enum(["implement", "verify"]),
  commandDigest: Sha256Schema,
  repositoryIdentity: SafeMetadataStringSchema.max(1_024),
  sourceCommit: CommitSchema,
  branch: z.string().regex(/^autostack\/[A-Za-z0-9._/-]{1,240}$/),
  cwdRoot: RelativeWorkspacePathSchema,
  networkPolicy: z.literal("host"),
  filesystemDisclosure: z.literal("host_user"),
  resourceLimits: ResourceLimitsSchema,
  allowedCredentialRefIds: z.array(CredentialRefIdSchema).max(128)
} as const;
export const CommandScopeSchema = z.object(CommandScopeShape).strict();
const CommandAuthorizationWithoutDigestSchema = z
  .object({
    id: CommandAuthorizationIdSchema,
    approvalId: ApprovalIdSchema,
    approvalEvidenceDigest: Sha256Schema,
    scope: CommandScopeSchema,
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expiresAt <= value.createdAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Expiry must follow creation."
      });
    }
  });
export const CommandAuthorizationSchema = CommandAuthorizationWithoutDigestSchema.extend({
  digest: Sha256Schema
}).strict();
export const CommandAuthorizationDigestInputSchema = CommandAuthorizationWithoutDigestSchema;

const isSafeJsonObject = (
  value: SafeJsonValue
): value is Readonly<{ [key: string]: SafeJsonValue }> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalJson = (value: SafeJsonValue): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isSafeJsonObject(value)) throw new TypeError("A JSON object is required.");
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
};

export const canonicalizeExecutionScope = (scope: unknown): string =>
  canonicalJson(normalizeSafeJson(ExecutionScopeSchema.parse(scope)));
export const canonicalizeEnvironmentAuthorizationForDigest = (authorization: unknown): string => {
  const { digest: _digest, ...digestInput } = EnvironmentAuthorizationSchema.parse(authorization);
  return canonicalJson(
    normalizeSafeJson(EnvironmentAuthorizationDigestInputSchema.parse(digestInput))
  );
};
export const canonicalizeCommandScope = (scope: unknown): string =>
  canonicalJson(normalizeSafeJson(CommandScopeSchema.parse(scope)));
export const canonicalizeCommandAuthorizationForDigest = (authorization: unknown): string => {
  const { digest: _digest, ...digestInput } = CommandAuthorizationSchema.parse(authorization);
  return canonicalJson(normalizeSafeJson(CommandAuthorizationDigestInputSchema.parse(digestInput)));
};

export function validateCommandAuthorizationAgainstEnvironment(
  authorization: CommandAuthorization,
  environmentAuthorization: EnvironmentAuthorization
): CommandAuthorization {
  const command = authorization.scope;
  const environment = environmentAuthorization.scope;
  const exactFields: ReadonlyArray<
    keyof Pick<
      ExecutionScope,
      | "workspaceId"
      | "runId"
      | "environmentId"
      | "repositoryIdentity"
      | "sourceCommit"
      | "branch"
      | "cwdRoot"
      | "networkPolicy"
      | "filesystemDisclosure"
    >
  > = [
    "workspaceId",
    "runId",
    "environmentId",
    "repositoryIdentity",
    "sourceCommit",
    "branch",
    "cwdRoot",
    "networkPolicy",
    "filesystemDisclosure"
  ];
  if (
    command.environmentAuthorizationId !== environmentAuthorization.id ||
    command.environmentAuthorizationDigest !== environmentAuthorization.digest ||
    exactFields.some((field) => command[field] !== environment[field]) ||
    command.resourceLimits.cpu > environment.resourceLimits.cpu ||
    command.resourceLimits.memoryMb > environment.resourceLimits.memoryMb ||
    command.resourceLimits.durationSeconds > environment.resourceLimits.durationSeconds ||
    command.allowedCredentialRefIds.some(
      (credentialRefId) => !environment.allowedCredentialRefIds.includes(credentialRefId)
    )
  ) {
    throw new TypeError(
      "Command authorization cannot broaden its environment authorization scope."
    );
  }
  return authorization;
}

const IdempotencyKeySchema = z.string().trim().min(1).max(256);
const IdempotencySchema = z.object({ key: IdempotencyKeySchema }).strict();
export const PrepareEnvironmentRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    environmentId: EnvironmentIdSchema,
    inspection: RepositoryInspectionSchema,
    sourceCommit: CommitSchema,
    branch: z.string().regex(/^autostack\/[A-Za-z0-9._/-]{1,240}$/),
    authorization: EnvironmentAuthorizationSchema,
    idempotency: IdempotencySchema
  })
  .strict()
  .superRefine((value, context) => {
    const scope = value.authorization.scope;
    if (
      scope.workspaceId !== value.workspaceId ||
      scope.runId !== value.runId ||
      scope.environmentId !== value.environmentId ||
      scope.repositoryIdentity !== value.inspection.repositoryIdentity ||
      scope.sourceCommit !== value.sourceCommit ||
      scope.branch !== value.branch
    ) {
      context.addIssue({
        code: "custom",
        message: "Prepare request must exactly match its authorization scope."
      });
    }
  });

export const StartCommandRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    environmentId: EnvironmentIdSchema,
    commandId: CommandIdSchema,
    command: CommandSpecSchema,
    authorization: CommandAuthorizationSchema,
    idempotency: IdempotencySchema
  })
  .strict()
  .superRefine((value, context) => {
    const scope = value.authorization.scope;
    if (
      scope.workspaceId !== value.workspaceId ||
      scope.runId !== value.runId ||
      scope.environmentId !== value.environmentId ||
      scope.commandId !== value.commandId
    ) {
      context.addIssue({
        code: "custom",
        message: "Command request must exactly match its authorization scope."
      });
    }
  });

export const CommandAcceptedSchema = z
  .object({ commandId: CommandIdSchema, acceptedAt: TimestampSchema, replayed: z.boolean() })
  .strict();
export const ReadCommandEventsRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    environmentId: EnvironmentIdSchema,
    commandId: CommandIdSchema,
    after: z.number().int().nonnegative().default(0)
  })
  .strict();
export const CancelCommandRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    environmentId: EnvironmentIdSchema,
    commandId: CommandIdSchema,
    idempotency: IdempotencySchema
  })
  .strict();
export const CancelCommandResponseSchema = z
  .object({ commandId: CommandIdSchema, cancelled: z.boolean(), replayed: z.boolean() })
  .strict();

export const ArtifactDescriptorSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    commandId: CommandIdSchema.optional(),
    kind: z.enum(["command_transcript", "command_output"]),
    mediaType: z.string().min(1).max(255),
    digest: Sha256Schema,
    byteSize: ByteCountSchema,
    createdAt: TimestampSchema
  })
  .strict();
export const ReadArtifactChunkRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    artifactId: ArtifactIdSchema,
    offset: ByteCountSchema,
    length: z.number().int().min(1).max(1_048_576)
  })
  .strict();
export const ReadArtifactChunkResponseSchema = z
  .object({
    artifact: ArtifactDescriptorSchema,
    offset: ByteCountSchema,
    bytes: z.string().max(1_398_104),
    nextOffset: ByteCountSchema,
    done: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.nextOffset < value.offset || value.nextOffset > value.artifact.byteSize) {
      context.addIssue({ code: "custom", message: "Artifact cursor is invalid." });
    }
    if (value.done !== (value.nextOffset === value.artifact.byteSize)) {
      context.addIssue({ code: "custom", message: "Artifact completion is invalid." });
    }
  });

export const DisposeEnvironmentRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    environmentId: EnvironmentIdSchema,
    terminalRunEvidence: z
      .object({
        status: z.enum(["completed", "cancelled", "failed"]),
        terminalEventSequence: PositiveSequenceSchema,
        terminalEventDigest: Sha256Schema
      })
      .strict(),
    idempotency: IdempotencySchema
  })
  .strict();
export const DisposeEnvironmentResponseSchema = z
  .object({ environmentId: EnvironmentIdSchema, disposed: z.boolean(), replayed: z.boolean() })
  .strict();

export const PreparedEnvironmentSchema = z
  .object({
    environmentId: EnvironmentIdSchema,
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    repositoryIdentity: SafeMetadataStringSchema.max(1_024),
    sourceCommit: CommitSchema,
    branch: z.string().regex(/^autostack\/[A-Za-z0-9._/-]{1,240}$/),
    authorization: EnvironmentAuthorizationSchema,
    state: z.enum(["prepared", "disposed"]),
    preparedAt: TimestampSchema
  })
  .strict();
export const ListEnvironmentsResponseSchema = z
  .object({ items: z.array(PreparedEnvironmentSchema).max(1_000) })
  .strict();

const EventBaseShape = {
  commandId: CommandIdSchema,
  sequence: PositiveSequenceSchema,
  occurredAt: TimestampSchema
} as const;
export const RunnerStreamEventSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("command.started"), ...EventBaseShape, pty: z.literal(true) })
    .strict(),
  z
    .object({
      type: z.literal("terminal.output"),
      ...EventBaseShape,
      stream: z.enum(["stdout", "stderr", "pty"]),
      text: SafeMetadataStringSchema.max(65_536)
    })
    .strict(),
  z
    .object({
      type: z.literal("terminal.truncated"),
      ...EventBaseShape,
      stream: z.enum(["stdout", "stderr", "pty"]),
      droppedBytes: ByteCountSchema.positive()
    })
    .strict(),
  z
    .object({
      type: z.literal("artifact.created"),
      ...EventBaseShape,
      artifact: ArtifactDescriptorSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("command.completed"),
      ...EventBaseShape,
      exitCode: z.number().int().min(0).max(255).nullable(),
      signal: z.string().min(1).max(64).nullable(),
      durationMs: ByteCountSchema,
      cancelled: z.boolean(),
      interrupted: z.boolean(),
      transcript: ArtifactDescriptorSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("stream.error"),
      ...EventBaseShape,
      code: z.enum(["protocol_failure", "output_quarantined", "guardian_lost"]),
      message: SafeMetadataStringSchema.max(2_000)
    })
    .strict()
]);
export const RunnerSubscriptionItemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("runner.event"), event: RunnerStreamEventSchema }).strict(),
  z
    .object({
      type: z.literal("subscription.lagged"),
      lastDurableSequence: z.number().int().nonnegative(),
      resumeCursor: z.number().int().nonnegative()
    })
    .strict()
    .superRefine((value, context) => {
      if (value.resumeCursor !== value.lastDurableSequence) {
        context.addIssue({
          code: "custom",
          message: "Lag resume cursor must equal the last durable sequence."
        });
      }
    })
]);

export const GuardianLaunchDescriptorSchema = z
  .object({
    electronExecutable: AbsolutePathSchema,
    guardianModule: AbsolutePathSchema,
    nativeDirectory: AbsolutePathSchema,
    desktopBuildRoot: AbsolutePathSchema,
    runtimeManifestDigest: Sha256Schema,
    electronVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    nodePtyVersion: z.string().regex(/^\d+\.\d+\.\d+$/)
  })
  .strict();

export type CommandSpec = z.infer<typeof CommandSpecSchema>;
export type RunnerCapabilities = z.infer<typeof RunnerCapabilitiesSchema>;
export type InspectRepositoryRequest = z.infer<typeof InspectRepositoryRequestSchema>;
export type RepositoryInspection = z.infer<typeof RepositoryInspectionSchema>;
export type ExecutionScope = z.infer<typeof ExecutionScopeSchema>;
export type EnvironmentAuthorization = z.infer<typeof EnvironmentAuthorizationSchema>;
export type CommandScope = z.infer<typeof CommandScopeSchema>;
export type CommandAuthorization = z.infer<typeof CommandAuthorizationSchema>;
export type PrepareEnvironmentRequest = z.infer<typeof PrepareEnvironmentRequestSchema>;
export type StartCommandRequest = z.infer<typeof StartCommandRequestSchema>;
export type CommandAccepted = z.infer<typeof CommandAcceptedSchema>;
export type ReadCommandEventsRequest = z.infer<typeof ReadCommandEventsRequestSchema>;
export type CancelCommandRequest = z.infer<typeof CancelCommandRequestSchema>;
export type CancelCommandResponse = z.infer<typeof CancelCommandResponseSchema>;
export type ArtifactDescriptor = z.infer<typeof ArtifactDescriptorSchema>;
export type ReadArtifactChunkRequest = z.infer<typeof ReadArtifactChunkRequestSchema>;
export type ReadArtifactChunkResponse = z.infer<typeof ReadArtifactChunkResponseSchema>;
export type DisposeEnvironmentRequest = z.infer<typeof DisposeEnvironmentRequestSchema>;
export type DisposeEnvironmentResponse = z.infer<typeof DisposeEnvironmentResponseSchema>;
export type PreparedEnvironment = z.infer<typeof PreparedEnvironmentSchema>;
export type ListEnvironmentsResponse = z.infer<typeof ListEnvironmentsResponseSchema>;
export type RunnerStreamEvent = z.infer<typeof RunnerStreamEventSchema>;
export type RunnerSubscriptionItem = z.infer<typeof RunnerSubscriptionItemSchema>;
export type GuardianLaunchDescriptor = z.infer<typeof GuardianLaunchDescriptorSchema>;
