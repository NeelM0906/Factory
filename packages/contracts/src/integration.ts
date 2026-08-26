import { z } from "zod";

import { ApprovalSchema } from "./entities.js";
import {
  ApprovalIdSchema,
  CredentialRefIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  WorkspaceIdSchema
} from "./ids.js";
import { PublicationEvidenceBundleSchema, admitPublicationEvidenceBundle } from "./pipeline.js";
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

const GitHubIngressDeliverySchema = z
  .object({
    schemaVersion: VersionSchema,
    provider: z.literal("github"),
    deliveryId: StableRefSchema,
    deduplicationKey: StableRefSchema,
    receivedAt: TimestampSchema,
    event: z.enum(["issues.opened", "issues.edited", "issues.labeled", "issue_comment.created"]),
    repository: z
      .object({ id: StableRefSchema, fullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/) })
      .strict(),
    issue: z
      .object({
        number: z.number().int().positive(),
        title: SafeMetadataStringSchema.max(240),
        body: z.string().max(100_000),
        authorId: StableRefSchema
      })
      .strict()
  })
  .strict();

const SlackIngressDeliverySchema = z
  .object({
    schemaVersion: VersionSchema,
    provider: z.literal("slack"),
    deliveryId: StableRefSchema,
    deduplicationKey: StableRefSchema,
    receivedAt: TimestampSchema,
    event: z.enum(["app_mention", "message", "message_action"]),
    slackWorkspaceId: StableRefSchema,
    channelId: StableRefSchema,
    threadTs: StableRefSchema,
    messageTs: StableRefSchema,
    userId: StableRefSchema,
    text: SafeMetadataStringSchema.max(100_000)
  })
  .strict();

export const IngressDeliverySchema = z.discriminatedUnion("provider", [
  GitHubIngressDeliverySchema,
  SlackIngressDeliverySchema
]);

const GitHubChannelBindingSchema = z
  .object({
    schemaVersion: VersionSchema,
    bindingRef: StableRefSchema,
    workspaceId: WorkspaceIdSchema,
    projectId: ProjectIdSchema,
    provider: z.literal("github"),
    installationId: StableRefSchema,
    repositoryId: StableRefSchema,
    repositoryFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    credentialRefId: CredentialRefIdSchema,
    enabled: z.boolean()
  })
  .strict();

const SlackChannelBindingSchema = z
  .object({
    schemaVersion: VersionSchema,
    bindingRef: StableRefSchema,
    workspaceId: WorkspaceIdSchema,
    projectId: ProjectIdSchema.optional(),
    provider: z.literal("slack"),
    slackWorkspaceId: StableRefSchema,
    channelId: StableRefSchema,
    botCredentialRefId: CredentialRefIdSchema,
    signingCredentialRefId: CredentialRefIdSchema,
    enabled: z.boolean()
  })
  .strict();

export const ChannelBindingSchema = z.discriminatedUnion("provider", [
  GitHubChannelBindingSchema,
  SlackChannelBindingSchema
]);

export const DraftPullRequestRequestSchema = z
  .object({
    schemaVersion: VersionSchema,
    idempotencyKey: IdempotencyKeySchema,
    repositoryFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    head: z.string().trim().min(1).max(255),
    base: z.string().trim().min(1).max(255),
    title: SafeMetadataStringSchema.max(240),
    body: SafeMetadataStringSchema.max(100_000),
    draft: z.literal(true),
    finalDiffDigest: DigestSchema,
    publicationEvidence: PublicationEvidenceBundleSchema
  })
  .strict()
  .superRefine((value, context) => {
    const scope = value.publicationEvidence.publishScope;
    const requestBindings = [
      ["repositoryFullName", value.repositoryFullName, scope.repositoryFullName],
      ["base", value.base, scope.base],
      ["head", value.head, scope.head],
      ["finalDiffDigest", value.finalDiffDigest, scope.finalDiffDigest]
    ] as const;
    for (const [field, actual, expected] of requestBindings) {
      if (actual !== expected) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `Draft pull request ${field} is outside the approved publish scope.`
        });
      }
    }
  });

export const DraftPullRequestResultSchema = z
  .object({
    schemaVersion: VersionSchema,
    idempotencyKey: IdempotencyKeySchema,
    repositoryFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    number: z.number().int().positive(),
    url: z.url(),
    draft: z.literal(true),
    providerEvidenceDigest: DigestSchema,
    createdAt: TimestampSchema
  })
  .strict();

export const admitDraftPullRequestRequest = async (
  input: unknown
): Promise<z.infer<typeof DraftPullRequestRequestSchema>> => {
  const request = DraftPullRequestRequestSchema.parse(input);
  await admitPublicationEvidenceBundle(request.publicationEvidence);
  return request;
};

export const SlackProgressRequestSchema = z
  .object({
    schemaVersion: VersionSchema,
    idempotencyKey: IdempotencyKeySchema,
    bindingRef: StableRefSchema,
    threadTs: StableRefSchema,
    text: SafeMetadataStringSchema.max(40_000),
    evidenceDigest: DigestSchema
  })
  .strict();

/**
 * One editable progress comment per run (spec §4.4). Omitting `commentId` creates the comment;
 * supplying it edits that comment in place instead of adding another.
 */
export const GitHubProgressCommentRequestSchema = z
  .object({
    schemaVersion: VersionSchema,
    idempotencyKey: IdempotencyKeySchema,
    bindingRef: StableRefSchema,
    repositoryFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    issueNumber: z.number().int().positive(),
    commentId: z.number().int().positive().optional(),
    body: SafeMetadataStringSchema.max(60_000),
    evidenceDigest: DigestSchema
  })
  .strict();

export const GitHubProgressCommentResultSchema = z
  .object({
    schemaVersion: VersionSchema,
    idempotencyKey: IdempotencyKeySchema,
    repositoryFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    issueNumber: z.number().int().positive(),
    commentId: z.number().int().positive(),
    url: z.url(),
    updated: z.boolean(),
    postedAt: TimestampSchema
  })
  .strict();

/** The structured sections a draft pull-request body must present (spec §4.4). */
export const DraftPullRequestBodySchema = z
  .object({
    schemaVersion: VersionSchema,
    problemStatement: SafeMetadataStringSchema.max(20_000),
    approvedPlanDigest: DigestSchema,
    approvedPlanSummary: SafeMetadataStringSchema.max(20_000),
    changeSummary: SafeMetadataStringSchema.max(20_000),
    verificationSummary: SafeMetadataStringSchema.max(20_000),
    reviewVerdict: z.literal("approved"),
    knownLimitations: z.array(SafeMetadataStringSchema.max(2_000)).max(50),
    runUrl: z.url()
  })
  .strict();

const ApprovalKindSchema = ApprovalSchema.shape.kind;

/** An approval prompt posted into a bound Slack thread with its evidence digest (spec §4.3). */
export const SlackApprovalPromptSchema = z
  .object({
    schemaVersion: VersionSchema,
    idempotencyKey: IdempotencyKeySchema,
    bindingRef: StableRefSchema,
    threadTs: StableRefSchema,
    runId: RunIdSchema,
    approvalId: ApprovalIdSchema,
    kind: ApprovalKindSchema,
    summary: SafeMetadataStringSchema.max(4_000),
    evidenceDigest: DigestSchema
  })
  .strict();

/** An interactive approve/reject payload, deduplicated like any other ingress delivery. */
export const SlackApprovalActionSchema = z
  .object({
    schemaVersion: VersionSchema,
    bindingRef: StableRefSchema,
    slackWorkspaceId: StableRefSchema,
    channelId: StableRefSchema,
    messageTs: StableRefSchema,
    userId: StableRefSchema,
    runId: RunIdSchema,
    approvalId: ApprovalIdSchema,
    decision: z.enum(["approved", "rejected"]),
    evidenceDigest: DigestSchema,
    deliveryId: StableRefSchema,
    deduplicationKey: StableRefSchema,
    triggeredAt: TimestampSchema
  })
  .strict();

export type IngressDelivery = z.infer<typeof IngressDeliverySchema>;
export type GitHubProgressCommentRequest = z.infer<typeof GitHubProgressCommentRequestSchema>;
export type GitHubProgressCommentResult = z.infer<typeof GitHubProgressCommentResultSchema>;
export type DraftPullRequestBody = z.infer<typeof DraftPullRequestBodySchema>;
export type SlackApprovalPrompt = z.infer<typeof SlackApprovalPromptSchema>;
export type SlackApprovalAction = z.infer<typeof SlackApprovalActionSchema>;
export type ChannelBinding = z.infer<typeof ChannelBindingSchema>;
export type DraftPullRequestRequest = z.infer<typeof DraftPullRequestRequestSchema>;
export type DraftPullRequestResult = z.infer<typeof DraftPullRequestResultSchema>;
export type SlackProgressRequest = z.infer<typeof SlackProgressRequestSchema>;

export interface IntegrationIngressPort {
  accept(delivery: IngressDelivery): Promise<{ readonly replayed: boolean }>;
}

export interface DeliveryIntegrationPort {
  createDraftPullRequest(request: DraftPullRequestRequest): Promise<DraftPullRequestResult>;
  postSlackProgress(request: SlackProgressRequest): Promise<void>;
}

/** Implemented alongside `DeliveryIntegrationPort` by the GitHub integration (spec §4.4). */
export interface GitHubProgressIntegrationPort {
  upsertProgressComment(
    request: GitHubProgressCommentRequest
  ): Promise<GitHubProgressCommentResult>;
}

/** Implemented alongside `DeliveryIntegrationPort` by the Slack integration (spec §4.3). */
export interface SlackApprovalIntegrationPort {
  postApprovalPrompt(prompt: SlackApprovalPrompt): Promise<void>;
}
