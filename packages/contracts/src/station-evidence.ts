import { z } from "zod";

import { CredentialRefIdSchema, RunIdSchema, WorkItemIdSchema, WorkspaceIdSchema } from "./ids.js";
import { PipelineStageSchema } from "./pipeline.js";
import { RelativeWorkspacePathSchema } from "./runner.js";
import { SafeMetadataStringSchema } from "./secret-safety.js";

const VersionSchema = z.literal(1);
const TimestampSchema = z.iso.datetime();
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/i);
const StableRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9._:/-]+$/);
const IdempotencyKeySchema = z.string().trim().min(1).max(240);
const SeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);
const OriginSchema = z.enum(["desktop", "web", "cli", "slack", "github", "api"]);

const StationIdentityShape = {
  schemaVersion: VersionSchema,
  workspaceId: WorkspaceIdSchema,
  workItemId: WorkItemIdSchema,
  runId: RunIdSchema
} as const;

export const TRIAGE_TASK_TYPES = ["bug", "feature", "chore", "documentation", "question"] as const;
export const TriageTaskTypeSchema = z.enum(TRIAGE_TASK_TYPES);

export const TRIAGE_COMPLEXITIES = ["trivial", "small", "medium", "large"] as const;
export const TriageComplexitySchema = z.enum(TRIAGE_COMPLEXITIES);

export const TriageDuplicateSchema = z
  .object({
    kind: z.enum(["work_item", "issue", "pull_request"]),
    reference: StableRefSchema,
    url: z.url().optional(),
    confidence: z.number().min(0).max(1)
  })
  .strict();

/** Triage station output (spec §8.2): type, priority, complexity, duplicates, actionability. */
export const TriageReportSchema = z
  .object({
    ...StationIdentityShape,
    taskType: TriageTaskTypeSchema,
    priority: z.enum(["low", "normal", "high", "urgent"]),
    complexity: TriageComplexitySchema,
    actionable: z.boolean(),
    rationale: SafeMetadataStringSchema.max(20_000),
    duplicates: z.array(TriageDuplicateSchema).max(20),
    clarificationRef: StableRefSchema.optional(),
    producedAt: TimestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    const references = value.duplicates.map((duplicate) => duplicate.reference);
    if (new Set(references).size !== references.length) {
      context.addIssue({
        code: "custom",
        path: ["duplicates"],
        message: "A duplicate reference may only be reported once."
      });
    }
  });

/**
 * A verification command as executable plus arguments (spec §14.4). Shell interpretation is
 * explicit so it is visible in the plan approval.
 */
export const VerificationCommandSchema = z
  .object({
    executable: SafeMetadataStringSchema.max(1_024),
    args: z.array(SafeMetadataStringSchema.max(4_096)).max(256),
    usesShell: z.boolean(),
    required: z.boolean()
  })
  .strict();

export const PLAN_PERMISSION_KINDS = [
  "filesystem_write",
  "network_egress",
  "secret_access",
  "destructive_action"
] as const;
export const PlanPermissionKindSchema = z.enum(PLAN_PERMISSION_KINDS);

/** Plan station output (spec §8.2), addressed by `planDigest` for approval staleness. */
export const PlanDocumentSchema = z
  .object({
    ...StationIdentityShape,
    planDigest: DigestSchema,
    summary: SafeMetadataStringSchema.max(20_000),
    acceptanceCriteria: z.array(SafeMetadataStringSchema.max(2_000)).min(1).max(50),
    affectedAreas: z.array(SafeMetadataStringSchema.max(1_000)).max(100),
    risks: z
      .array(
        z
          .object({ severity: SeveritySchema, summary: SafeMetadataStringSchema.max(2_000) })
          .strict()
      )
      .max(50),
    verificationCommands: z.array(VerificationCommandSchema).min(1).max(50),
    requiredPermissions: z
      .array(
        z
          .object({
            kind: PlanPermissionKindSchema,
            detail: SafeMetadataStringSchema.max(2_000)
          })
          .strict()
      )
      .max(50),
    requiredCredentialRefIds: z.array(CredentialRefIdSchema).max(32),
    producedAt: TimestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.verificationCommands.some((command) => command.required)) {
      context.addIssue({
        code: "custom",
        path: ["verificationCommands"],
        message: "A plan must name at least one required verification command."
      });
    }
  });

export const VerificationResultSchema = z
  .object({
    command: VerificationCommandSchema,
    status: z.enum(["passed", "failed", "skipped"]),
    exitCode: z.number().int().min(0).max(255).optional(),
    durationMs: z.number().int().nonnegative(),
    startedAt: TimestampSchema,
    outputDigest: DigestSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "skipped" && value.exitCode !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["exitCode"],
        message: "A skipped check has no exit code."
      });
    }
    if (value.status !== "skipped" && value.exitCode === undefined) {
      context.addIssue({
        code: "custom",
        path: ["exitCode"],
        message: "An executed check must record its exit code."
      });
    }
  });

/** Verify station output (spec §8.2): exact commands, exit codes, and durations are retained. */
export const VerificationReportSchema = z
  .object({
    ...StationIdentityShape,
    planDigest: DigestSchema,
    status: z.enum(["passed", "failed"]),
    results: z.array(VerificationResultSchema).min(1).max(100),
    producedAt: TimestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status !== "passed") return;
    for (const [index, result] of value.results.entries()) {
      if (result.command.required && result.status !== "passed") {
        context.addIssue({
          code: "custom",
          path: ["results", index, "status"],
          message: "A required check that did not pass makes verification fail."
        });
      }
    }
  });

export const ReviewFindingLocationSchema = z
  .object({
    path: RelativeWorkspacePathSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endLine < value.startLine) {
      context.addIssue({
        code: "custom",
        path: ["endLine"],
        message: "A finding location must end at or after it starts."
      });
    }
  });

export const ReviewFindingSchema = z
  .object({
    findingRef: StableRefSchema,
    severity: SeveritySchema,
    summary: SafeMetadataStringSchema.max(2_000),
    evidenceDigest: DigestSchema,
    location: ReviewFindingLocationSchema.optional()
  })
  .strict();

/** Review station output (spec §8.2): findings with severity, location, evidence, and a verdict. */
export const ReviewReportSchema = z
  .object({
    ...StationIdentityShape,
    planDigest: DigestSchema,
    reviewedDiffDigest: DigestSchema,
    verificationReportDigest: DigestSchema,
    verdict: z.enum(["approved", "changes_requested"]),
    summary: SafeMetadataStringSchema.max(20_000),
    findings: z.array(ReviewFindingSchema).max(500),
    producedAt: TimestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    const findingRefs = value.findings.map((finding) => finding.findingRef);
    if (new Set(findingRefs).size !== findingRefs.length) {
      context.addIssue({
        code: "custom",
        path: ["findings"],
        message: "Finding identifiers must be unique."
      });
    }
    if (
      value.verdict === "approved" &&
      value.findings.some(
        (finding) => finding.severity === "critical" || finding.severity === "high"
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "Approved reviews cannot contain critical or high findings."
      });
    }
  });

/** A focused question that moves a run to `needs_clarification` or `waiting_for_user`. */
export const ClarificationRequestSchema = z
  .object({
    ...StationIdentityShape,
    clarificationRef: StableRefSchema,
    stage: PipelineStageSchema,
    question: SafeMetadataStringSchema.max(4_000),
    evidenceDigest: DigestSchema,
    requestedAt: TimestampSchema
  })
  .strict();

export const ClarificationResponseSchema = z
  .object({
    schemaVersion: VersionSchema,
    idempotencyKey: IdempotencyKeySchema,
    runId: RunIdSchema,
    clarificationRef: StableRefSchema,
    answer: SafeMetadataStringSchema.max(20_000),
    origin: OriginSchema,
    actorId: z.string().trim().min(1).max(240),
    answeredAt: TimestampSchema
  })
  .strict();

export type TriageTaskType = z.infer<typeof TriageTaskTypeSchema>;
export type TriageComplexity = z.infer<typeof TriageComplexitySchema>;
export type TriageDuplicate = z.infer<typeof TriageDuplicateSchema>;
export type TriageReport = z.infer<typeof TriageReportSchema>;
export type VerificationCommand = z.infer<typeof VerificationCommandSchema>;
export type PlanPermissionKind = z.infer<typeof PlanPermissionKindSchema>;
export type PlanDocument = z.infer<typeof PlanDocumentSchema>;
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
export type VerificationReport = z.infer<typeof VerificationReportSchema>;
export type ReviewFindingLocation = z.infer<typeof ReviewFindingLocationSchema>;
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type ReviewReport = z.infer<typeof ReviewReportSchema>;
export type ClarificationRequest = z.infer<typeof ClarificationRequestSchema>;
export type ClarificationResponse = z.infer<typeof ClarificationResponseSchema>;
