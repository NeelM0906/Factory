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
  containsSensitiveMaterial,
  normalizeSafeJson,
  SafeMetadataStringSchema,
  type SafeJsonValue
} from "./secret-safety.js";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const CommitSchema = z.string().regex(/^[0-9a-f]{40}$/);
const TimestampSchema = z.iso.datetime({ offset: true });
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
const SafeCommandStringSchema = z
  .string()
  .max(8_192)
  .refine(
    (value) => !value.includes("\u0000") && !containsSensitiveMaterial(value),
    "Command strings cannot contain NUL bytes or credential material."
  );
export const CommandEnvironmentEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("literal"),
      name: EnvironmentNameSchema,
      value: z
        .string()
        .max(8_192)
        .refine(
          (value) => !value.includes("\u0000") && !containsSensitiveMaterial(value),
          "Literal environment values cannot contain NUL bytes or credential material."
        )
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
    executable: SafeCommandStringSchema.trim().min(1).max(1_024),
    args: z.array(SafeCommandStringSchema).max(256),
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
  .strict()
  .superRefine((value, context) => {
    const names = new Set<string>();
    for (const [index, entry] of value.environment.entries()) {
      if (names.has(entry.name)) {
        context.addIssue({
          code: "custom",
          path: ["environment", index, "name"],
          message: "Environment variable names must be unique."
        });
      }
      names.add(entry.name);
    }
  });

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
  .strict()
  .superRefine((value, context) => {
    const local =
      value.supportedNetworkPolicies.length === 1 &&
      value.supportedNetworkPolicies[0] === "host" &&
      value.enforcement.cpu !== "hard" &&
      value.enforcement.memory !== "hard" &&
      value.enforcement.network === "unavailable" &&
      value.enforcement.childFilesystem === "unavailable" &&
      value.enforcement.duration === "hard" &&
      value.enforcement.autostackPathOperations === "hard";
    if (!local) {
      context.addIssue({
        code: "custom",
        message: "Local runner capabilities must describe only enforceable host-user controls."
      });
    }
  });

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

const GeneratedBranchSchema = z
  .string()
  .max(250)
  .regex(/^autostack\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/)
  .refine((branch) => !branch.includes(".."), "Generated branches cannot contain traversal.");
const CredentialReferenceSetSchema = z
  .array(CredentialRefIdSchema)
  .max(128)
  .superRefine((value, context) => {
    if (new Set(value).size !== value.length) {
      context.addIssue({ code: "custom", message: "Credential references must be unique." });
    }
  });
const ExecutionScopeShape = {
  workspaceId: WorkspaceIdSchema,
  runId: RunIdSchema,
  environmentId: EnvironmentIdSchema,
  repositoryIdentity: SafeMetadataStringSchema.max(1_024),
  sourceCommit: CommitSchema,
  branch: GeneratedBranchSchema,
  cwdRoot: RelativeWorkspacePathSchema,
  resourceLimits: ResourceLimitsSchema,
  networkPolicy: z.literal("host"),
  filesystemDisclosure: z.literal("host_user"),
  allowedCredentialRefIds: CredentialReferenceSetSchema
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
    if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
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
  branch: GeneratedBranchSchema,
  cwdRoot: RelativeWorkspacePathSchema,
  networkPolicy: z.literal("host"),
  filesystemDisclosure: z.literal("host_user"),
  resourceLimits: ResourceLimitsSchema,
  allowedCredentialRefIds: CredentialReferenceSetSchema
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
    if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
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
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
};

const snapshot = (candidate: unknown): SafeJsonValue => normalizeSafeJson(candidate);
const canonicalDigestInput = (domain: string, value: SafeJsonValue): string =>
  canonicalJson({ domain, version: 1, value });
const sha256Hex = async (input: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
const isAtOrAfter = (now: string, expiry: string): boolean => Date.parse(now) >= Date.parse(expiry);

export const canonicalizeExecutionScope = (scope: unknown): string =>
  canonicalDigestInput(
    "autostack.execution-scope",
    snapshot(ExecutionScopeSchema.parse(snapshot(scope)))
  );
export const canonicalizeEnvironmentAuthorizationForDigest = (authorization: unknown): string => {
  const { digest: _digest, ...digestInput } = EnvironmentAuthorizationSchema.parse(
    snapshot(authorization)
  );
  return canonicalDigestInput(
    "autostack.environment-authorization",
    snapshot(EnvironmentAuthorizationDigestInputSchema.parse(snapshot(digestInput)))
  );
};
export const canonicalizeCommandScope = (scope: unknown): string =>
  canonicalDigestInput(
    "autostack.command-scope",
    snapshot(CommandScopeSchema.parse(snapshot(scope)))
  );
export const canonicalizeCommandAuthorizationForDigest = (authorization: unknown): string => {
  const { digest: _digest, ...digestInput } = CommandAuthorizationSchema.parse(
    snapshot(authorization)
  );
  return canonicalDigestInput(
    "autostack.command-authorization",
    snapshot(CommandAuthorizationDigestInputSchema.parse(snapshot(digestInput)))
  );
};
export const canonicalizeCommandSpec = (command: unknown): string =>
  canonicalDigestInput(
    "autostack.command-spec",
    snapshot(CommandSpecSchema.parse(snapshot(command)))
  );
export const digestExecutionScope = async (scope: unknown): Promise<string> =>
  sha256Hex(canonicalizeExecutionScope(scope));
export const digestEnvironmentAuthorization = async (authorization: unknown): Promise<string> =>
  sha256Hex(canonicalizeEnvironmentAuthorizationForDigest(authorization));
export const digestCommandScope = async (scope: unknown): Promise<string> =>
  sha256Hex(canonicalizeCommandScope(scope));
export const digestCommandAuthorization = async (authorization: unknown): Promise<string> =>
  sha256Hex(canonicalizeCommandAuthorizationForDigest(authorization));
export const digestCommandSpec = async (command: unknown): Promise<string> =>
  sha256Hex(canonicalizeCommandSpec(command));

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

const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const IdempotencySchema = z.object({ key: IdempotencyKeySchema }).strict();
export const PrepareEnvironmentRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    environmentId: EnvironmentIdSchema,
    inspection: RepositoryInspectionSchema,
    sourceCommit: CommitSchema,
    branch: GeneratedBranchSchema,
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
      value.inspection.sourceCommit !== value.sourceCommit ||
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
    environmentAuthorizationId: EnvironmentAuthorizationIdSchema,
    environmentAuthorizationDigest: Sha256Schema,
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
      scope.commandId !== value.commandId ||
      scope.environmentAuthorizationId !== value.environmentAuthorizationId ||
      scope.environmentAuthorizationDigest !== value.environmentAuthorizationDigest
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
    environmentAuthorizationId: EnvironmentAuthorizationIdSchema,
    environmentAuthorizationDigest: Sha256Schema,
    commandAuthorizationId: CommandAuthorizationIdSchema,
    commandAuthorizationDigest: Sha256Schema,
    after: z.number().int().nonnegative().default(0)
  })
  .strict();
export const CancelCommandRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    environmentId: EnvironmentIdSchema,
    commandId: CommandIdSchema,
    environmentAuthorizationId: EnvironmentAuthorizationIdSchema,
    environmentAuthorizationDigest: Sha256Schema,
    commandAuthorizationId: CommandAuthorizationIdSchema,
    commandAuthorizationDigest: Sha256Schema,
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
    commandId: CommandIdSchema,
    kind: z.enum(["command_transcript", "command_output"]),
    mediaType: z
      .string()
      .max(255)
      .regex(/^[a-z]+\/[a-z0-9!#$&^_.+-]+(?:; charset=[A-Za-z0-9._-]+)?$/),
    digest: Sha256Schema,
    byteSize: ByteCountSchema,
    createdAt: TimestampSchema
  })
  .strict();
export const ReadArtifactChunkRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    environmentId: EnvironmentIdSchema,
    commandId: CommandIdSchema,
    artifactId: ArtifactIdSchema,
    environmentAuthorizationId: EnvironmentAuthorizationIdSchema,
    environmentAuthorizationDigest: Sha256Schema,
    commandAuthorizationId: CommandAuthorizationIdSchema,
    commandAuthorizationDigest: Sha256Schema,
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
    const padding = value.bytes.endsWith("==") ? 2 : value.bytes.endsWith("=") ? 1 : 0;
    const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value.bytes
    );
    const decodedByteLength = canonicalBase64 ? (value.bytes.length / 4) * 3 - padding : 0;
    if (!canonicalBase64 || decodedByteLength > 1_048_576) {
      context.addIssue({
        code: "custom",
        path: ["bytes"],
        message: "Artifact bytes must be bounded canonical base64."
      });
    }
    if (
      value.nextOffset < value.offset ||
      value.nextOffset > value.artifact.byteSize ||
      value.nextOffset - value.offset !== decodedByteLength
    ) {
      context.addIssue({ code: "custom", message: "Artifact cursor is invalid." });
    }
    if (!value.done && decodedByteLength === 0) {
      context.addIssue({
        code: "custom",
        message: "A nonterminal artifact chunk must make progress."
      });
    }
    if (value.done !== (value.nextOffset === value.artifact.byteSize)) {
      context.addIssue({ code: "custom", message: "Artifact completion is invalid." });
    }
  });

export const TerminalRunEvidenceSchema = z
  .object({
    status: z.enum(["completed", "cancelled", "failed"]),
    terminalEventSequence: PositiveSequenceSchema,
    terminalEventDigest: Sha256Schema
  })
  .strict();
export const DisposeEnvironmentRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    environmentId: EnvironmentIdSchema,
    environmentAuthorizationId: EnvironmentAuthorizationIdSchema,
    environmentAuthorizationDigest: Sha256Schema,
    terminalRunEvidence: TerminalRunEvidenceSchema,
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
    branch: GeneratedBranchSchema,
    authorization: EnvironmentAuthorizationSchema,
    preparedAt: TimestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    const scope = value.authorization.scope;
    if (
      scope.workspaceId !== value.workspaceId ||
      scope.runId !== value.runId ||
      scope.environmentId !== value.environmentId ||
      scope.repositoryIdentity !== value.repositoryIdentity ||
      scope.sourceCommit !== value.sourceCommit ||
      scope.branch !== value.branch
    ) {
      context.addIssue({
        code: "custom",
        message: "Prepared environment must match its authorization."
      });
    }
  });
export const ListEnvironmentsResponseSchema = z
  .object({ items: z.array(PreparedEnvironmentSchema).max(1_000) })
  .strict();

const cwdIsWithin = (cwdRoot: string, cwd: string): boolean =>
  cwdRoot === "." || cwd === cwdRoot || cwd.startsWith(`${cwdRoot}/`);
const assertDigest = (actual: string, expected: string, label: string): void => {
  if (actual !== expected) throw new TypeError(`${label} digest is invalid.`);
};
const assertUnexpired = (expiresAt: string, now: string, label: string): void => {
  if (isAtOrAfter(now, expiresAt)) throw new TypeError(`${label} is expired.`);
};

export interface PrepareEnvironmentAdmission {
  readonly request: PrepareEnvironmentRequest;
}

export async function admitPrepareEnvironment(
  candidate: unknown,
  now: unknown
): Promise<PrepareEnvironmentAdmission> {
  const request = PrepareEnvironmentRequestSchema.parse(snapshot(candidate));
  const parsedNow = TimestampSchema.parse(snapshot(now));
  const authorization = request.authorization;
  assertUnexpired(authorization.expiresAt, parsedNow, "Environment authorization");
  assertDigest(
    authorization.approvalEvidenceDigest,
    await digestExecutionScope(authorization.scope),
    "Environment approval evidence"
  );
  assertDigest(
    authorization.digest,
    await digestEnvironmentAuthorization(authorization),
    "Environment authorization"
  );
  return { request };
}

export interface StartCommandAdmission {
  readonly request: StartCommandRequest;
  readonly environmentAuthorization: EnvironmentAuthorization;
}

export async function admitStartCommand(
  candidate: unknown,
  environmentAuthorizationCandidate: unknown,
  now: unknown
): Promise<StartCommandAdmission> {
  const request = StartCommandRequestSchema.parse(snapshot(candidate));
  const environmentAuthorization = EnvironmentAuthorizationSchema.parse(
    snapshot(environmentAuthorizationCandidate)
  );
  const parsedNow = TimestampSchema.parse(snapshot(now));
  const authorization = request.authorization;
  assertUnexpired(environmentAuthorization.expiresAt, parsedNow, "Environment authorization");
  assertUnexpired(authorization.expiresAt, parsedNow, "Command authorization");
  validateCommandAuthorizationAgainstEnvironment(authorization, environmentAuthorization);
  assertDigest(
    authorization.approvalEvidenceDigest,
    await digestCommandScope(authorization.scope),
    "Command approval evidence"
  );
  assertDigest(
    authorization.digest,
    await digestCommandAuthorization(authorization),
    "Command authorization"
  );
  assertDigest(
    authorization.scope.commandDigest,
    await digestCommandSpec(request.command),
    "Command specification"
  );
  if (
    !cwdIsWithin(authorization.scope.cwdRoot, request.command.cwd) ||
    request.command.timeoutSeconds > authorization.scope.resourceLimits.durationSeconds ||
    request.command.environment.some(
      (entry) =>
        entry.kind === "credential_ref" &&
        !authorization.scope.allowedCredentialRefIds.includes(entry.credentialRefId)
    )
  ) {
    throw new TypeError("Command is outside its recorded authorization scope.");
  }
  return { request, environmentAuthorization };
}

export const validateArtifactChunkResponse = (
  requestCandidate: unknown,
  responseCandidate: unknown
): ReadArtifactChunkResponse => {
  const request = ReadArtifactChunkRequestSchema.parse(snapshot(requestCandidate));
  const response = ReadArtifactChunkResponseSchema.parse(snapshot(responseCandidate));
  if (
    response.artifact.artifactId !== request.artifactId ||
    response.artifact.workspaceId !== request.workspaceId ||
    response.artifact.runId !== request.runId ||
    response.artifact.commandId !== request.commandId ||
    response.offset !== request.offset ||
    response.nextOffset - response.offset > request.length
  ) {
    throw new TypeError("Artifact chunk does not match its request.");
  }
  return response;
};

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
      stream: z.literal("pty"),
      text: SafeMetadataStringSchema.max(65_536)
    })
    .strict(),
  z
    .object({
      type: z.literal("terminal.truncated"),
      ...EventBaseShape,
      stream: z.literal("pty"),
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

export const validateRunnerStream = (
  candidates: readonly unknown[]
): readonly RunnerStreamEvent[] => {
  const events = candidates.map((candidate) => RunnerStreamEventSchema.parse(snapshot(candidate)));
  if (events.length === 0) throw new TypeError("A command stream requires terminal evidence.");
  const commandId = events[0]?.commandId;
  let terminal = false;
  let previousSequence = 0;
  for (const event of events) {
    if (event.commandId !== commandId || event.sequence <= previousSequence || terminal) {
      throw new TypeError("Runner stream sequence is incoherent.");
    }
    if (event.type === "artifact.created" && event.artifact.commandId !== event.commandId) {
      throw new TypeError("Artifact event command identity is invalid.");
    }
    if (
      event.type === "command.completed" &&
      (event.transcript.commandId !== event.commandId ||
        event.transcript.kind !== "command_transcript")
    ) {
      throw new TypeError("Command transcript identity is invalid.");
    }
    previousSequence = event.sequence;
    terminal = event.type === "command.completed" || event.type === "stream.error";
  }
  if (!terminal) throw new TypeError("Runner stream requires exactly one terminal event.");
  return events;
};

export const GuardianLaunchDescriptorSchema = z
  .object({
    electronExecutable: AbsolutePathSchema,
    guardianModule: AbsolutePathSchema,
    nativeDirectory: AbsolutePathSchema,
    desktopBuildRoot: AbsolutePathSchema,
    runtimeManifestDigest: Sha256Schema,
    electronVersion: z.literal("43.4.0"),
    nodePtyVersion: z.literal("1.1.0")
  })
  .strict()
  .superRefine((value, context) => {
    const insideBuildRoot = (path: string) =>
      path.startsWith(`${value.desktopBuildRoot}/`) && path !== value.desktopBuildRoot;
    if (!insideBuildRoot(value.guardianModule) || !insideBuildRoot(value.nativeDirectory)) {
      context.addIssue({
        code: "custom",
        message:
          "Guardian module and native directory must be lexically contained by the desktop build root."
      });
    }
  });

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
