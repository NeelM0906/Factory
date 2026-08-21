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
import type { ApprovalId, CommandAuthorizationId, EnvironmentAuthorizationId } from "./ids.js";
import { ApprovalSchema, type Approval } from "./entities.js";
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
    (value) =>
      value.startsWith("/") &&
      !value.includes("\u0000") &&
      !value.includes("\\") &&
      !value.includes("//") &&
      value
        .split("/")
        .every((segment, index) => index === 0 || (segment !== "." && segment !== "..")),
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
const ShellInterpreterBasenames = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "ash"
]);
const shellBasename = (executable: string): string =>
  (executable.split("/").at(-1) ?? executable).toLowerCase();
const isCommandStringFlag = (argument: string): boolean =>
  argument === "-c" ||
  argument === "-lc" ||
  argument === "-cl" ||
  argument.startsWith("-c=") ||
  argument.startsWith("-lc=") ||
  /^-[A-Za-z]*c[A-Za-z]*$/.test(argument) ||
  argument === "--command" ||
  argument.startsWith("--command=");
const hasShellCommandStringFlag = (argumentsToInspect: readonly string[]): boolean => {
  for (const argument of argumentsToInspect) {
    if (argument === "--") return false;
    if (isCommandStringFlag(argument)) return true;
  }
  return false;
};
const usesEnvSplitString = (executable: string, args: readonly string[]): boolean =>
  executable === "env" &&
  args.some(
    (argument) =>
      argument === "-S" || argument === "--split-string" || argument.startsWith("--split-string=")
  );
const hasImplicitWrapperShellCommandString = (
  executable: string,
  args: readonly string[]
): boolean => {
  if (executable !== "sudo" && executable !== "doas") return false;
  return args.some(
    (argument) =>
      argument === "-s" || argument === "--shell" || argument === "-i" || argument === "--login"
  );
};
const isForbiddenShellCommandString = (command: {
  readonly executable: string;
  readonly args: readonly string[];
}): boolean => {
  const executable = shellBasename(command.executable);
  // env -S parses a command string itself, so it cannot be safely admitted as
  // an argument-vector command even when the embedded shell is not tokenized yet.
  if (usesEnvSplitString(executable, command.args)) return true;
  if (hasImplicitWrapperShellCommandString(executable, command.args)) return true;
  const tokens = [command.executable, ...command.args];
  return tokens.some(
    (token, index) =>
      ShellInterpreterBasenames.has(shellBasename(token)) &&
      hasShellCommandStringFlag(tokens.slice(index + 1))
  );
};
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
    if (isForbiddenShellCommandString(value)) {
      context.addIssue({
        code: "custom",
        path: ["executable"],
        message: "Shell command-string execution is forbidden."
      });
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
    filesystemDisclosure: z.literal("host_user"),
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
      value.filesystemDisclosure === "host_user" &&
      value.enforcement.cpu === "advisory" &&
      value.enforcement.memory === "advisory" &&
      value.enforcement.network === "unavailable" &&
      value.enforcement.childFilesystem === "advisory" &&
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
  .superRefine((branch, context) => {
    const segments = branch.split("/");
    if (
      branch.includes("..") ||
      branch.endsWith(".") ||
      branch.endsWith("/") ||
      branch.includes("//") ||
      branch.includes("@{") ||
      branch.endsWith(".lock") ||
      segments.some((segment) => segment === "." || segment === ".." || segment.endsWith(".lock"))
    ) {
      context.addIssue({
        code: "custom",
        message: "Generated branches must be unambiguous AutoStack Git references."
      });
    }
  });
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
const normalizeTimestampForDigest = (value: string): string => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError("A valid timestamp is required.");
  return parsed.toISOString();
};
const isAtOrAfter = (now: string, expiry: string): boolean => Date.parse(now) >= Date.parse(expiry);
const isAfter = (left: string, right: string): boolean => Date.parse(left) > Date.parse(right);
const sortCodeUnits = <T>(values: readonly T[], key: (value: T) => string): T[] =>
  [...values].sort((left, right) => {
    const leftKey = key(left);
    const rightKey = key(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
const normalizeExecutionScopeForDigest = (candidate: unknown): ExecutionScope => {
  const parsed = ExecutionScopeSchema.parse(snapshot(candidate));
  return {
    ...parsed,
    allowedCredentialRefIds: sortCodeUnits(parsed.allowedCredentialRefIds, (value) => value)
  };
};
const normalizeCommandSpecForDigest = (candidate: unknown): CommandSpec => {
  const parsed = CommandSpecSchema.parse(snapshot(candidate));
  return {
    ...parsed,
    environment: sortCodeUnits(parsed.environment, (entry) => entry.name)
  };
};
const normalizeEnvironmentAuthorizationForDigest = (candidate: unknown) => {
  const parsed = EnvironmentAuthorizationSchema.parse(snapshot(candidate));
  const { digest: _digest, ...withoutDigest } = parsed;
  return {
    ...withoutDigest,
    scope: normalizeExecutionScopeForDigest(withoutDigest.scope),
    createdAt: normalizeTimestampForDigest(withoutDigest.createdAt),
    expiresAt: normalizeTimestampForDigest(withoutDigest.expiresAt)
  };
};
const normalizeCommandScopeForDigest = (candidate: unknown): CommandScope => {
  const parsed = CommandScopeSchema.parse(snapshot(candidate));
  return {
    ...parsed,
    allowedCredentialRefIds: sortCodeUnits(parsed.allowedCredentialRefIds, (value) => value)
  };
};
const normalizeCommandAuthorizationForDigest = (candidate: unknown) => {
  const parsed = CommandAuthorizationSchema.parse(snapshot(candidate));
  const { digest: _digest, ...withoutDigest } = parsed;
  return {
    ...withoutDigest,
    scope: normalizeCommandScopeForDigest(withoutDigest.scope),
    createdAt: normalizeTimestampForDigest(withoutDigest.createdAt),
    expiresAt: normalizeTimestampForDigest(withoutDigest.expiresAt)
  };
};

export type ApprovalEvidenceKind = "plan" | "permission" | "publish";
const normalizeApprovalEvidence = (
  kind: ApprovalEvidenceKind,
  evidence: unknown
): SafeJsonValue => {
  const candidate = snapshot(evidence);
  if (kind === "plan") {
    const parsed = ExecutionScopeSchema.safeParse(candidate);
    return parsed.success ? snapshot(normalizeExecutionScopeForDigest(parsed.data)) : candidate;
  }
  if (kind === "permission") {
    const parsed = CommandScopeSchema.safeParse(candidate);
    return parsed.success ? snapshot(normalizeCommandScopeForDigest(parsed.data)) : candidate;
  }
  return candidate;
};
export const canonicalizeApprovalEvidence = (
  kind: ApprovalEvidenceKind,
  evidence: unknown
): string =>
  canonicalDigestInput(
    `autostack.approval-evidence.${kind}`,
    normalizeApprovalEvidence(kind, evidence)
  );
export const canonicalizeVersionedDigestValue = (domain: string, value: unknown): string =>
  canonicalDigestInput(domain, snapshot(value));

export const canonicalizeExecutionScope = (scope: unknown): string =>
  canonicalizeApprovalEvidence("plan", normalizeExecutionScopeForDigest(scope));
export const canonicalizeEnvironmentAuthorizationForDigest = (authorization: unknown): string => {
  return canonicalDigestInput(
    "autostack.environment-authorization",
    snapshot(
      EnvironmentAuthorizationDigestInputSchema.parse(
        snapshot(normalizeEnvironmentAuthorizationForDigest(authorization))
      )
    )
  );
};
export const canonicalizeCommandScope = (scope: unknown): string =>
  canonicalizeApprovalEvidence("permission", normalizeCommandScopeForDigest(scope));
export const canonicalizeCommandAuthorizationForDigest = (authorization: unknown): string => {
  return canonicalDigestInput(
    "autostack.command-authorization",
    snapshot(
      CommandAuthorizationDigestInputSchema.parse(
        snapshot(normalizeCommandAuthorizationForDigest(authorization))
      )
    )
  );
};
export const canonicalizeCommandSpec = (command: unknown): string =>
  canonicalDigestInput("autostack.command-spec", snapshot(normalizeCommandSpecForDigest(command)));
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
export const digestVersionedValue = async (domain: string, value: unknown): Promise<string> =>
  sha256Hex(canonicalizeVersionedDigestValue(domain, value));

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
    const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const finalDataCharacter =
      padding === 2 ? value.bytes.at(-3) : padding === 1 ? value.bytes.at(-2) : undefined;
    const canonicalPaddingBits =
      finalDataCharacter === undefined ||
      (padding === 2
        ? (base64Alphabet.indexOf(finalDataCharacter) & 0b1111) === 0
        : (base64Alphabet.indexOf(finalDataCharacter) & 0b11) === 0);
    const decodedByteLength = canonicalBase64 ? (value.bytes.length / 4) * 3 - padding : 0;
    if (!canonicalBase64 || !canonicalPaddingBits || decodedByteLength > 1_048_576) {
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
    state: z.literal("prepared"),
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
  readonly approval: Approval;
  readonly environmentAuthorization: EnvironmentAuthorization;
}

export interface TrustedRunnerAdmissionDependencies {
  readonly resolveApproval: (approvalId: ApprovalId) => Promise<unknown>;
  readonly resolveEnvironmentAuthorization: (
    authorizationId: EnvironmentAuthorizationId
  ) => Promise<unknown>;
  readonly resolveCommandAuthorization: (
    authorizationId: CommandAuthorizationId
  ) => Promise<unknown>;
}

const parseTrustedApproval = async (
  approvalId: ApprovalId,
  kind: ApprovalEvidenceKind,
  workspaceId: string,
  runId: string,
  evidenceDigest: string,
  now: string,
  dependencies: TrustedRunnerAdmissionDependencies
): Promise<Approval> => {
  const candidate = await dependencies.resolveApproval(approvalId);
  if (candidate === undefined) throw new TypeError("A trusted approved authorization is required.");
  const approval = ApprovalSchema.parse(snapshot(candidate));
  if (
    approval.id !== approvalId ||
    approval.kind !== kind ||
    approval.status !== "approved" ||
    approval.decision?.decision !== "approved" ||
    approval.workspaceId !== workspaceId ||
    approval.runId !== runId ||
    approval.evidenceDigest !== evidenceDigest ||
    isAfter(approval.createdAt, now) ||
    approval.decision === undefined ||
    isAfter(approval.decision.decidedAt, now) ||
    isAfter(approval.updatedAt, now)
  ) {
    throw new TypeError("Trusted approval evidence is invalid or stale.");
  }
  return approval;
};

const assertTrustedEnvironmentAuthorization = async (
  authorization: EnvironmentAuthorization,
  now: string,
  dependencies: TrustedRunnerAdmissionDependencies
): Promise<EnvironmentAuthorization> => {
  const candidate = await dependencies.resolveEnvironmentAuthorization(authorization.id);
  if (candidate === undefined)
    throw new TypeError("A trusted environment authorization is required.");
  const trusted = EnvironmentAuthorizationSchema.parse(snapshot(candidate));
  const [providedDigest, trustedDigest] = await Promise.all([
    digestEnvironmentAuthorization(authorization),
    digestEnvironmentAuthorization(trusted)
  ]);
  if (
    authorization.digest !== providedDigest ||
    trusted.digest !== trustedDigest ||
    authorization.id !== trusted.id ||
    authorization.digest !== trusted.digest ||
    canonicalizeEnvironmentAuthorizationForDigest(authorization) !==
      canonicalizeEnvironmentAuthorizationForDigest(trusted) ||
    isAfter(authorization.createdAt, now) ||
    isAfter(trusted.createdAt, now)
  ) {
    throw new TypeError("Trusted environment authorization is invalid.");
  }
  assertUnexpired(trusted.expiresAt, now, "Environment authorization");
  return trusted;
};

const assertTrustedCommandAuthorization = async (
  authorization: CommandAuthorization,
  now: string,
  dependencies: TrustedRunnerAdmissionDependencies
): Promise<CommandAuthorization> => {
  const candidate = await dependencies.resolveCommandAuthorization(authorization.id);
  if (candidate === undefined) throw new TypeError("A trusted command authorization is required.");
  const trusted = CommandAuthorizationSchema.parse(snapshot(candidate));
  const [providedDigest, trustedDigest] = await Promise.all([
    digestCommandAuthorization(authorization),
    digestCommandAuthorization(trusted)
  ]);
  if (
    authorization.digest !== providedDigest ||
    trusted.digest !== trustedDigest ||
    authorization.id !== trusted.id ||
    authorization.digest !== trusted.digest ||
    canonicalizeCommandAuthorizationForDigest(authorization) !==
      canonicalizeCommandAuthorizationForDigest(trusted) ||
    isAfter(authorization.createdAt, now) ||
    isAfter(trusted.createdAt, now)
  ) {
    throw new TypeError("Trusted command authorization is invalid.");
  }
  assertUnexpired(trusted.expiresAt, now, "Command authorization");
  return trusted;
};

export async function admitPrepareEnvironment(
  candidate: unknown,
  now: unknown,
  dependencies: TrustedRunnerAdmissionDependencies
): Promise<PrepareEnvironmentAdmission> {
  const request = PrepareEnvironmentRequestSchema.parse(snapshot(candidate));
  const parsedNow = TimestampSchema.parse(snapshot(now));
  const authorization = request.authorization;
  if (isAfter(authorization.createdAt, parsedNow)) {
    throw new TypeError("Environment authorization was created in the future.");
  }
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
  const trustedAuthorization = await assertTrustedEnvironmentAuthorization(
    authorization,
    parsedNow,
    dependencies
  );
  const approval = await parseTrustedApproval(
    trustedAuthorization.approvalId,
    "plan",
    request.workspaceId,
    request.runId,
    trustedAuthorization.approvalEvidenceDigest,
    parsedNow,
    dependencies
  );
  return { request, approval, environmentAuthorization: trustedAuthorization };
}

export interface StartCommandAdmission {
  readonly request: StartCommandRequest;
  readonly environmentAuthorization: EnvironmentAuthorization;
  readonly commandAuthorization: CommandAuthorization;
  readonly approval: Approval;
}

export async function admitStartCommand(
  candidate: unknown,
  now: unknown,
  dependencies: TrustedRunnerAdmissionDependencies
): Promise<StartCommandAdmission> {
  const request = StartCommandRequestSchema.parse(snapshot(candidate));
  const parsedNow = TimestampSchema.parse(snapshot(now));
  const environmentAuthorization = EnvironmentAuthorizationSchema.parse(
    snapshot(await dependencies.resolveEnvironmentAuthorization(request.environmentAuthorizationId))
  );
  const authorization = request.authorization;
  const trustedEnvironmentAuthorization = await assertTrustedEnvironmentAuthorization(
    environmentAuthorization,
    parsedNow,
    dependencies
  );
  const trustedAuthorization = await assertTrustedCommandAuthorization(
    authorization,
    parsedNow,
    dependencies
  );
  await parseTrustedApproval(
    trustedEnvironmentAuthorization.approvalId,
    "plan",
    request.workspaceId,
    request.runId,
    trustedEnvironmentAuthorization.approvalEvidenceDigest,
    parsedNow,
    dependencies
  );
  validateCommandAuthorizationAgainstEnvironment(
    trustedAuthorization,
    trustedEnvironmentAuthorization
  );
  assertDigest(
    trustedAuthorization.approvalEvidenceDigest,
    await digestCommandScope(trustedAuthorization.scope),
    "Command approval evidence"
  );
  assertDigest(
    trustedAuthorization.digest,
    await digestCommandAuthorization(trustedAuthorization),
    "Command authorization"
  );
  assertDigest(
    trustedAuthorization.scope.commandDigest,
    await digestCommandSpec(request.command),
    "Command specification"
  );
  if (
    !cwdIsWithin(trustedAuthorization.scope.cwdRoot, request.command.cwd) ||
    request.command.timeoutSeconds > trustedAuthorization.scope.resourceLimits.durationSeconds ||
    request.command.environment.some(
      (entry) =>
        entry.kind === "credential_ref" &&
        !trustedAuthorization.scope.allowedCredentialRefIds.includes(entry.credentialRefId)
    )
  ) {
    throw new TypeError("Command is outside its recorded authorization scope.");
  }
  const approval = await parseTrustedApproval(
    trustedAuthorization.approvalId,
    "permission",
    request.workspaceId,
    request.runId,
    trustedAuthorization.approvalEvidenceDigest,
    parsedNow,
    dependencies
  );
  return {
    request,
    approval,
    environmentAuthorization: trustedEnvironmentAuthorization,
    commandAuthorization: trustedAuthorization
  };
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
  workspaceId: WorkspaceIdSchema,
  runId: RunIdSchema,
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
    .strict()
    .superRefine((value, context) => {
      if (
        value.artifact.workspaceId !== value.workspaceId ||
        value.artifact.runId !== value.runId ||
        value.artifact.commandId !== value.commandId
      ) {
        context.addIssue({ code: "custom", message: "Artifact event identity is invalid." });
      }
    }),
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
    .strict()
    .superRefine((value, context) => {
      if (
        value.transcript.workspaceId !== value.workspaceId ||
        value.transcript.runId !== value.runId ||
        value.transcript.commandId !== value.commandId ||
        value.transcript.kind !== "command_transcript" ||
        (value.exitCode === null && value.signal === null) ||
        (value.exitCode !== null && value.signal !== null)
      ) {
        context.addIssue({ code: "custom", message: "Command completion evidence is invalid." });
      }
    }),
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
  candidates: readonly unknown[],
  expected?: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly commandId: string;
    readonly after: number;
  }
): readonly RunnerStreamEvent[] => {
  if (candidates.length > 10_000) throw new TypeError("Runner stream exceeds its frame bound.");
  const events = candidates.map((candidate) => RunnerStreamEventSchema.parse(snapshot(candidate)));
  if (events.length === 0) throw new TypeError("A command stream requires terminal evidence.");
  const first = events[0];
  if (first === undefined) throw new TypeError("A command stream requires terminal evidence.");
  const commandId = expected?.commandId ?? first.commandId;
  let terminal = false;
  let previousSequence = expected?.after ?? 0;
  let started = false;
  for (const event of events) {
    if (
      expected !== undefined &&
      (event.workspaceId !== expected.workspaceId || event.runId !== expected.runId)
    ) {
      throw new TypeError("Runner stream identity is incoherent.");
    }
    if (event.commandId !== commandId || event.sequence !== previousSequence + 1 || terminal) {
      throw new TypeError("Runner stream sequence is incoherent.");
    }
    if (event.type === "command.started") {
      if (previousSequence !== 0 || started) {
        throw new TypeError("Runner stream has an invalid command.started event.");
      }
      started = true;
    } else if (previousSequence === 0) {
      throw new TypeError("Runner stream must start with command.started.");
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
export type TerminalRunEvidence = z.infer<typeof TerminalRunEvidenceSchema>;
export type PreparedEnvironment = z.infer<typeof PreparedEnvironmentSchema>;
export type ListEnvironmentsResponse = z.infer<typeof ListEnvironmentsResponseSchema>;
export type RunnerStreamEvent = z.infer<typeof RunnerStreamEventSchema>;
export type RunnerSubscriptionItem = z.infer<typeof RunnerSubscriptionItemSchema>;
export type GuardianLaunchDescriptor = z.infer<typeof GuardianLaunchDescriptorSchema>;
