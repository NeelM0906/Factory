import { z } from "zod";

import {
  AgentSessionIdSchema,
  ApprovalIdSchema,
  ArtifactIdSchema,
  EnvironmentIdSchema,
  RunIdSchema,
  WorkItemIdSchema,
  WorkspaceIdSchema
} from "./ids.js";
import { digestVersionedValue } from "./runner.js";
import { SafeMetadataStringSchema } from "./secret-safety.js";

const VersionSchema = z.literal(1);
const TimestampSchema = z.iso.datetime();
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/i);
const IdempotencyKeySchema = z.string().trim().min(1).max(240);

export const PIPELINE_STAGES = [
  "triage",
  "plan",
  "plan_approval",
  "implement",
  "verify",
  "isolated_review",
  "publish_approval",
  "draft_pr"
] as const;
export const PipelineStageSchema = z.enum(PIPELINE_STAGES);

const PipelineIdentityShape = {
  workspaceId: WorkspaceIdSchema,
  workItemId: WorkItemIdSchema,
  runId: RunIdSchema
} as const;

const EvidenceContextShape = {
  schemaVersion: VersionSchema,
  ...PipelineIdentityShape,
  evidenceDigest: DigestSchema,
  artifactIds: z.array(ArtifactIdSchema).max(100),
  producedAt: TimestampSchema
} as const;

export const TriageEvidenceSchema = z
  .object({
    ...EvidenceContextShape,
    stage: z.literal("triage"),
    summary: SafeMetadataStringSchema.max(20_000),
    /**
     * The `TriageReport` this envelope addresses, by `digestTriageReport`. Optional so evidence
     * recorded before a report exists stays valid, but naming it is what lets a verifier bind the
     * document to the envelope — without it triage is the one station whose evidence can only be
     * checked for run identity, while plan, verify, and review all bind their documents.
     */
    triageReportDigest: DigestSchema.optional()
  })
  .strict();

export const PlanEvidenceSchema = z
  .object({
    ...EvidenceContextShape,
    stage: z.literal("plan"),
    planDigest: DigestSchema
  })
  .strict();

export const PlanApprovalEvidenceSchema = z
  .object({
    ...EvidenceContextShape,
    stage: z.literal("plan_approval"),
    approvalId: ApprovalIdSchema,
    decision: z.literal("approved"),
    approvedEvidenceDigest: DigestSchema,
    actorId: z.string().trim().min(1).max(240)
  })
  .strict();

export const ImplementationEvidenceSchema = z
  .object({
    ...EvidenceContextShape,
    stage: z.literal("implement"),
    planApprovalEvidenceDigest: DigestSchema,
    agentSessionId: AgentSessionIdSchema,
    environmentId: EnvironmentIdSchema,
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/i),
    resultCommit: z.string().regex(/^[0-9a-f]{40}$/i),
    finalDiffDigest: DigestSchema
  })
  .strict();

export const VerificationEvidenceSchema = z
  .object({
    ...EvidenceContextShape,
    stage: z.literal("verify"),
    implementationEvidenceDigest: DigestSchema,
    status: z.literal("passed")
  })
  .strict();

export const ReviewEvidenceSchema = z
  .object({
    ...EvidenceContextShape,
    stage: z.literal("isolated_review"),
    implementationEvidenceDigest: DigestSchema,
    verificationEvidenceDigest: DigestSchema,
    reviewedDiffDigest: DigestSchema,
    implementation: z
      .object({
        agentSessionId: AgentSessionIdSchema,
        environmentId: EnvironmentIdSchema
      })
      .strict(),
    reviewer: z
      .object({
        agentSessionId: AgentSessionIdSchema,
        environmentId: EnvironmentIdSchema
      })
      .strict(),
    verdict: z.enum(["approved", "changes_requested"]),
    findings: z
      .array(
        z
          .object({
            severity: z.enum(["critical", "high", "medium", "low", "info"]),
            summary: SafeMetadataStringSchema.max(2_000),
            evidenceDigest: DigestSchema
          })
          .strict()
      )
      .max(500)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.implementation.agentSessionId === value.reviewer.agentSessionId) {
      context.addIssue({
        code: "custom",
        path: ["reviewer", "agentSessionId"],
        message: "Review must use a different agent session from implementation."
      });
    }
    if (value.implementation.environmentId === value.reviewer.environmentId) {
      context.addIssue({
        code: "custom",
        path: ["reviewer", "environmentId"],
        message: "Review must use an isolated environment."
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

export const PublishScopeSchema = z
  .object({
    schemaVersion: VersionSchema,
    ...PipelineIdentityShape,
    repositoryFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    base: z.string().trim().min(1).max(255),
    head: z.string().trim().min(1).max(255),
    finalDiffDigest: DigestSchema,
    action: z.literal("create_draft_pr"),
    scopeDigest: DigestSchema,
    createdAt: TimestampSchema
  })
  .strict();

export const PublishApprovalEvidenceSchema = z
  .object({
    ...EvidenceContextShape,
    stage: z.literal("publish_approval"),
    approvalId: ApprovalIdSchema,
    decision: z.literal("approved"),
    approvedEvidenceDigest: DigestSchema,
    reviewEvidenceDigest: DigestSchema,
    publishScopeDigest: DigestSchema,
    actorId: z.string().trim().min(1).max(240)
  })
  .strict();

const DraftPrEvidenceSchema = z
  .object({
    ...EvidenceContextShape,
    stage: z.literal("draft_pr"),
    pullRequestUrl: z.url(),
    pullRequestNumber: z.number().int().positive(),
    draft: z.literal(true),
    reviewEvidenceDigest: DigestSchema,
    publishApprovalEvidenceDigest: DigestSchema
  })
  .strict();

export const PipelineEvidenceSchema = z.union([
  TriageEvidenceSchema,
  PlanEvidenceSchema,
  PlanApprovalEvidenceSchema,
  ImplementationEvidenceSchema,
  VerificationEvidenceSchema,
  ReviewEvidenceSchema,
  PublishApprovalEvidenceSchema,
  DraftPrEvidenceSchema
]);

export const PublicationEvidenceBundleSchema = z
  .object({
    schemaVersion: VersionSchema,
    ...PipelineIdentityShape,
    plan: PlanEvidenceSchema,
    planApproval: PlanApprovalEvidenceSchema,
    implementation: ImplementationEvidenceSchema,
    verification: VerificationEvidenceSchema,
    review: ReviewEvidenceSchema,
    publishScope: PublishScopeSchema,
    publishApproval: PublishApprovalEvidenceSchema
  })
  .strict()
  .superRefine((value, context) => {
    const identityEvidence = [
      ["plan", value.plan],
      ["planApproval", value.planApproval],
      ["implementation", value.implementation],
      ["verification", value.verification],
      ["review", value.review],
      ["publishScope", value.publishScope],
      ["publishApproval", value.publishApproval]
    ] as const;
    for (const [name, evidence] of identityEvidence) {
      if (
        evidence.workspaceId !== value.workspaceId ||
        evidence.workItemId !== value.workItemId ||
        evidence.runId !== value.runId
      ) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "Publication evidence identity does not match the requested run."
        });
      }
    }

    const requireMatch = (
      actual: string,
      expected: string,
      path: readonly (string | number)[],
      message: string
    ): void => {
      if (actual !== expected) context.addIssue({ code: "custom", path: [...path], message });
    };
    requireMatch(
      value.planApproval.approvedEvidenceDigest,
      value.plan.evidenceDigest,
      ["planApproval", "approvedEvidenceDigest"],
      "Plan approval is not bound to this plan."
    );
    requireMatch(
      value.implementation.planApprovalEvidenceDigest,
      value.planApproval.evidenceDigest,
      ["implementation", "planApprovalEvidenceDigest"],
      "Implementation is not bound to this plan approval."
    );
    requireMatch(
      value.verification.implementationEvidenceDigest,
      value.implementation.evidenceDigest,
      ["verification", "implementationEvidenceDigest"],
      "Verification is not bound to this implementation."
    );
    requireMatch(
      value.review.implementationEvidenceDigest,
      value.implementation.evidenceDigest,
      ["review", "implementationEvidenceDigest"],
      "Review is not bound to this implementation."
    );
    requireMatch(
      value.review.verificationEvidenceDigest,
      value.verification.evidenceDigest,
      ["review", "verificationEvidenceDigest"],
      "Review is not bound to this verification."
    );
    requireMatch(
      value.review.reviewedDiffDigest,
      value.implementation.finalDiffDigest,
      ["review", "reviewedDiffDigest"],
      "Review is stale for the final diff."
    );
    requireMatch(
      value.review.implementation.agentSessionId,
      value.implementation.agentSessionId,
      ["review", "implementation", "agentSessionId"],
      "Review references an unrelated implementation session."
    );
    requireMatch(
      value.review.implementation.environmentId,
      value.implementation.environmentId,
      ["review", "implementation", "environmentId"],
      "Review references an unrelated implementation environment."
    );
    requireMatch(
      value.publishScope.finalDiffDigest,
      value.implementation.finalDiffDigest,
      ["publishScope", "finalDiffDigest"],
      "Publish scope is stale for the final diff."
    );
    requireMatch(
      value.publishApproval.reviewEvidenceDigest,
      value.review.evidenceDigest,
      ["publishApproval", "reviewEvidenceDigest"],
      "Publish approval is not bound to this review."
    );
    requireMatch(
      value.publishApproval.publishScopeDigest,
      value.publishScope.scopeDigest,
      ["publishApproval", "publishScopeDigest"],
      "Publish approval is not bound to this publish scope."
    );
    requireMatch(
      value.publishApproval.approvedEvidenceDigest,
      value.publishScope.scopeDigest,
      ["publishApproval", "approvedEvidenceDigest"],
      "Publish approval does not approve this stable publish scope."
    );
    if (value.review.verdict !== "approved") {
      context.addIssue({
        code: "custom",
        path: ["review", "verdict"],
        message: "Publication requires an approved independent review."
      });
    }

    const chronologicalEvidence = [
      ["plan", value.plan.producedAt],
      ["planApproval", value.planApproval.producedAt],
      ["implementation", value.implementation.producedAt],
      ["verification", value.verification.producedAt],
      ["review", value.review.producedAt],
      ["publishScope", value.publishScope.createdAt],
      ["publishApproval", value.publishApproval.producedAt]
    ] as const;
    for (let index = 1; index < chronologicalEvidence.length; index += 1) {
      const previous = chronologicalEvidence[index - 1]!;
      const current = chronologicalEvidence[index]!;
      if (Date.parse(current[1]) < Date.parse(previous[1])) {
        context.addIssue({
          code: "custom",
          path: [current[0]],
          message: "Publication evidence is stale or out of sequence."
        });
      }
    }
  });

export const canonicalizePublishScopeForDigest = (
  scope: z.infer<typeof PublishScopeSchema>
): Readonly<Record<string, unknown>> => ({
  schemaVersion: scope.schemaVersion,
  workspaceId: scope.workspaceId,
  workItemId: scope.workItemId,
  runId: scope.runId,
  repositoryFullName: scope.repositoryFullName,
  base: scope.base,
  head: scope.head,
  finalDiffDigest: scope.finalDiffDigest,
  action: scope.action
});

export const digestPublishScope = async (
  input: z.input<typeof PublishScopeSchema>
): Promise<string> => {
  const scope = PublishScopeSchema.parse(input);
  return digestVersionedValue("autostack.publish-scope", canonicalizePublishScopeForDigest(scope));
};

export const admitPublicationEvidenceBundle = async (
  input: unknown
): Promise<z.infer<typeof PublicationEvidenceBundleSchema>> => {
  const evidence = PublicationEvidenceBundleSchema.parse(input);
  if ((await digestPublishScope(evidence.publishScope)) !== evidence.publishScope.scopeDigest) {
    throw new TypeError("Publish scope digest does not match its canonical fields.");
  }
  return evidence;
};

export const PipelineStageRequestSchema = z
  .object({
    schemaVersion: VersionSchema,
    idempotencyKey: IdempotencyKeySchema,
    ...PipelineIdentityShape,
    stage: PipelineStageSchema,
    attempt: z.number().int().positive(),
    inputEvidenceDigests: z.array(DigestSchema).max(100),
    requestedAt: TimestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.stage !== "triage" && value.inputEvidenceDigests.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["inputEvidenceDigests"],
        message: "Every stage after triage requires prior evidence."
      });
    }
  });

const nextStage = new Map<(typeof PIPELINE_STAGES)[number], (typeof PIPELINE_STAGES)[number]>(
  PIPELINE_STAGES.slice(0, -1).map((stage, index) => [stage, PIPELINE_STAGES[index + 1]!])
);

export const assertPipelineTransition = (
  from: z.infer<typeof PipelineStageSchema>,
  to: z.infer<typeof PipelineStageSchema>
): z.infer<typeof PipelineStageSchema> => {
  if (nextStage.get(from) !== to) {
    throw new TypeError(`Invalid delivery pipeline transition: ${from} -> ${to}.`);
  }
  return to;
};

/** Milestone A allows at most three attempts per agent stage (spec §8.3). */
export const PIPELINE_REWORK_MAX_ATTEMPTS = 3;

/** The two stages that can judge the implementation and send it back (spec §8.2). */
const PIPELINE_REWORK_SOURCE_STAGES = new Set<string>(["verify", "isolated_review"]);

/**
 * A failed judgement of the implementation routes back to implement (spec §8.2) instead of
 * advancing through `assertPipelineTransition`. The bound keeps the loop finite and never marks the
 * judging stage passed.
 *
 * Both judging stages qualify. A failed verification is the same situation as a failed review — the
 * implementation is wrong and the fix belongs to the implement station — and routing it forward
 * into review instead would ask a reviewer to approve code its own tests reject.
 */
export const assertPipelineReworkTransition = (
  from: z.infer<typeof PipelineStageSchema>,
  attempt: number,
  maxAttempts: number = PIPELINE_REWORK_MAX_ATTEMPTS
): z.infer<typeof PipelineStageSchema> => {
  if (!PIPELINE_REWORK_SOURCE_STAGES.has(from)) {
    throw new TypeError(
      `Delivery pipeline rework may only follow verify or isolated_review, not ${from}.`
    );
  }
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new TypeError("Delivery pipeline rework requires a positive attempt number.");
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError("Delivery pipeline rework requires a positive attempt bound.");
  }
  if (attempt >= maxAttempts) {
    throw new TypeError(
      `Delivery pipeline rework attempts are exhausted after ${maxAttempts} attempts.`
    );
  }
  return "implement";
};

export type PipelineStage = z.infer<typeof PipelineStageSchema>;
export type PipelineStageRequest = z.infer<typeof PipelineStageRequestSchema>;
export type PipelineEvidence = z.infer<typeof PipelineEvidenceSchema>;
export type ReviewEvidence = z.infer<typeof ReviewEvidenceSchema>;
export type PublishScope = z.infer<typeof PublishScopeSchema>;
export type PublicationEvidenceBundle = z.infer<typeof PublicationEvidenceBundleSchema>;

export interface DeliveryPipelinePort {
  execute(request: PipelineStageRequest): Promise<PipelineEvidence>;
}
