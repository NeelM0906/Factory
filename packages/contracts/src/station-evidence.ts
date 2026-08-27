import { z } from "zod";

import { CredentialRefIdSchema, RunIdSchema, WorkItemIdSchema, WorkspaceIdSchema } from "./ids.js";
import { PipelineStageSchema } from "./pipeline.js";
import { RelativeWorkspacePathSchema, digestVersionedValue } from "./runner.js";
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

/**
 * Which adapter, prompt, and route authored a station document (spec §16.2). Optional because a
 * document may be authored by a human or by an adapter that has no prompt registry, and because it
 * is provenance rather than content — see `canonicalizePlanDocumentForDigest` for the one place
 * that distinction changes a digest.
 */
export const StationProvenanceSchema = z
  .object({
    adapterId: StableRefSchema,
    promptRef: StableRefSchema,
    promptVersion: StableRefSchema,
    routeRef: StableRefSchema.optional()
  })
  .strict();

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
    producedAt: TimestampSchema,
    producedBy: StationProvenanceSchema.optional()
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
    producedAt: TimestampSchema,
    producedBy: StationProvenanceSchema.optional()
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
    if (value.status === "passed") {
      for (const [index, result] of value.results.entries()) {
        if (result.command.required && result.status !== "passed") {
          context.addIssue({
            code: "custom",
            path: ["results", index, "status"],
            message: "A required check that did not pass makes verification fail."
          });
        }
      }
      return;
    }
    if (value.results.every((result) => result.status === "passed")) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "A failed verification must record a check that did not pass."
      });
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
    producedAt: TimestampSchema,
    producedBy: StationProvenanceSchema.optional()
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

/**
 * The document a station produced, tagged by the stage that produced it. The four document shapes
 * share no discriminating field of their own — a plan and a review are simply different objects —
 * so the tag is what lets an event carry any of them and a reader know which admission rule applies.
 */
export const PipelineStationDocumentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("triage"), report: TriageReportSchema }).strict(),
  z.object({ kind: z.literal("plan"), document: PlanDocumentSchema }).strict(),
  z.object({ kind: z.literal("verify"), report: VerificationReportSchema }).strict(),
  z.object({ kind: z.literal("isolated_review"), report: ReviewReportSchema }).strict()
]);

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

export type StationProvenance = z.infer<typeof StationProvenanceSchema>;
export type TriageReport = z.infer<typeof TriageReportSchema>;
export type PlanDocument = z.infer<typeof PlanDocumentSchema>;
export type VerificationReport = z.infer<typeof VerificationReportSchema>;
export type ReviewReport = z.infer<typeof ReviewReportSchema>;

/**
 * The plan document's canonical form, mirroring `canonicalizePublishScopeForDigest`.
 *
 * Three fields are deliberately excluded. `planDigest` is the digest itself. `producedAt` and
 * `producedBy` are record metadata rather than approved content: spec §14.2 invalidates an approval
 * only when the plan changes *materially*, so re-planning byte-identical content under a new prompt
 * version, adapter, or route must digest identically — otherwise every prompt bump would silently
 * revoke every outstanding plan approval. Every remaining field is what a human approved and
 * therefore what staleness is measured against.
 *
 * `canonicalJson` sorts object keys before hashing, so the key order written here does not affect
 * the digest; array order does, which is correct for ordered acceptance criteria and commands.
 */
export const canonicalizePlanDocumentForDigest = (
  document: PlanDocument
): Readonly<Record<string, unknown>> => ({
  schemaVersion: document.schemaVersion,
  workspaceId: document.workspaceId,
  workItemId: document.workItemId,
  runId: document.runId,
  summary: document.summary,
  acceptanceCriteria: document.acceptanceCriteria,
  affectedAreas: document.affectedAreas,
  risks: document.risks,
  verificationCommands: document.verificationCommands,
  requiredPermissions: document.requiredPermissions,
  requiredCredentialRefIds: document.requiredCredentialRefIds
});

export const digestPlanDocument = async (
  input: z.input<typeof PlanDocumentSchema>
): Promise<string> => {
  const document = PlanDocumentSchema.parse(input);
  return digestVersionedValue(
    "autostack.plan-document",
    canonicalizePlanDocumentForDigest(document)
  );
};

/**
 * The verification report's canonical form. Unlike the plan document it has no self-digest field to
 * exclude, and every field — including `producedAt` and each result's `startedAt` and `durationMs` —
 * is evidence of one specific execution rather than approved content, so all of it is covered.
 */
export const canonicalizeVerificationReportForDigest = (
  report: VerificationReport
): Readonly<Record<string, unknown>> => ({
  schemaVersion: report.schemaVersion,
  workspaceId: report.workspaceId,
  workItemId: report.workItemId,
  runId: report.runId,
  planDigest: report.planDigest,
  status: report.status,
  results: report.results,
  producedAt: report.producedAt
});

export const digestVerificationReport = async (
  input: z.input<typeof VerificationReportSchema>
): Promise<string> => {
  const report = VerificationReportSchema.parse(input);
  return digestVersionedValue(
    "autostack.verification-report",
    canonicalizeVerificationReportForDigest(report)
  );
};

/**
 * The triage report's canonical form. Like the verification report and unlike the plan document, a
 * triage report is evidence of one specific execution rather than approved content, so every field
 * is covered — `producedAt` and `producedBy` included. Nothing here is measured for approval
 * staleness, so nothing needs to survive a re-run unchanged.
 */
export const canonicalizeTriageReportForDigest = (
  report: TriageReport
): Readonly<Record<string, unknown>> => ({
  schemaVersion: report.schemaVersion,
  workspaceId: report.workspaceId,
  workItemId: report.workItemId,
  runId: report.runId,
  taskType: report.taskType,
  priority: report.priority,
  complexity: report.complexity,
  actionable: report.actionable,
  rationale: report.rationale,
  duplicates: report.duplicates,
  producedAt: report.producedAt,
  // An absent optional contributes nothing rather than a `undefined` the digest cannot serialize,
  // so a document that omits one and a document that sets it to `undefined` are the same document.
  ...(report.clarificationRef === undefined ? {} : { clarificationRef: report.clarificationRef }),
  ...(report.producedBy === undefined ? {} : { producedBy: report.producedBy })
});

export const digestTriageReport = async (
  input: z.input<typeof TriageReportSchema>
): Promise<string> => {
  const report = TriageReportSchema.parse(input);
  return digestVersionedValue("autostack.triage-report", canonicalizeTriageReportForDigest(report));
};

/**
 * The review report's canonical form, covering every field for the same reason the verification
 * report does: a review is a reading of one exact implementation, verification, and plan, and a
 * later reading under a different prompt is a different reading.
 */
export const canonicalizeReviewReportForDigest = (
  report: ReviewReport
): Readonly<Record<string, unknown>> => ({
  schemaVersion: report.schemaVersion,
  workspaceId: report.workspaceId,
  workItemId: report.workItemId,
  runId: report.runId,
  planDigest: report.planDigest,
  reviewedDiffDigest: report.reviewedDiffDigest,
  verificationReportDigest: report.verificationReportDigest,
  verdict: report.verdict,
  summary: report.summary,
  findings: report.findings,
  producedAt: report.producedAt,
  ...(report.producedBy === undefined ? {} : { producedBy: report.producedBy })
});

export const digestReviewReport = async (
  input: z.input<typeof ReviewReportSchema>
): Promise<string> => {
  const report = ReviewReportSchema.parse(input);
  return digestVersionedValue("autostack.review-report", canonicalizeReviewReportForDigest(report));
};

interface StationIdentity {
  readonly workspaceId: string;
  readonly workItemId: string;
  readonly runId: string;
}

const assertSameRun = (left: StationIdentity, right: StationIdentity, subject: string): void => {
  if (
    left.workspaceId !== right.workspaceId ||
    left.workItemId !== right.workItemId ||
    left.runId !== right.runId
  ) {
    throw new TypeError(`${subject} belongs to a different run.`);
  }
};

/** Admits a plan document only when its `planDigest` covers its own canonical content. */
export const admitPlanDocument = async (input: unknown): Promise<PlanDocument> => {
  const document = PlanDocumentSchema.parse(input);
  if ((await digestPlanDocument(document)) !== document.planDigest) {
    throw new TypeError("Plan document digest does not match its canonical fields.");
  }
  return document;
};

/**
 * Admits a triage report against the digest a caller recorded for it. Triage is the first station,
 * so there is no upstream document to bind to and no self-digest field: the only thing that can be
 * checked is that this is the exact report that digest was taken over.
 */
export const admitTriageReport = async (
  input: unknown,
  expectedDigest: string
): Promise<TriageReport> => {
  const report = TriageReportSchema.parse(input);
  if ((await digestTriageReport(report)) !== expectedDigest) {
    throw new TypeError("Triage report does not match the digest it was recorded under.");
  }
  return report;
};

/** Admits a verification report only when it verifies the plan document it names. */
export const admitVerificationReport = async (
  input: unknown,
  planDocumentInput: unknown
): Promise<VerificationReport> => {
  const plan = await admitPlanDocument(planDocumentInput);
  const report = VerificationReportSchema.parse(input);
  assertSameRun(report, plan, "Verification report");
  if (report.planDigest !== plan.planDigest) {
    throw new TypeError("Verification report is not bound to this plan document.");
  }
  return report;
};

/** Admits a review report only when it read this plan and this verification evidence. */
export const admitReviewReport = async (
  input: unknown,
  planDocumentInput: unknown,
  verificationReportInput: unknown
): Promise<ReviewReport> => {
  const plan = await admitPlanDocument(planDocumentInput);
  const verification = await admitVerificationReport(verificationReportInput, plan);
  const review = ReviewReportSchema.parse(input);
  assertSameRun(review, plan, "Review report");
  if (review.planDigest !== plan.planDigest) {
    throw new TypeError("Review report is not bound to this plan document.");
  }
  if (review.verificationReportDigest !== (await digestVerificationReport(verification))) {
    throw new TypeError("Review report is stale for this verification report.");
  }
  return review;
};

export type TriageTaskType = z.infer<typeof TriageTaskTypeSchema>;
export type TriageComplexity = z.infer<typeof TriageComplexitySchema>;
export type TriageDuplicate = z.infer<typeof TriageDuplicateSchema>;

export type VerificationCommand = z.infer<typeof VerificationCommandSchema>;
export type PlanPermissionKind = z.infer<typeof PlanPermissionKindSchema>;
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
export type ReviewFindingLocation = z.infer<typeof ReviewFindingLocationSchema>;
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type PipelineStationDocument = z.infer<typeof PipelineStationDocumentSchema>;
export type ClarificationRequest = z.infer<typeof ClarificationRequestSchema>;
export type ClarificationResponse = z.infer<typeof ClarificationResponseSchema>;
