import type { PlanDocument, VerificationReport } from "@autostack/contracts";

/** One upstream document handed to a role for a single invocation. */
export interface NativeRoleInput {
  readonly label: string;
  readonly content: string;
}

/**
 * The reviewed diff as the role inputs describe it: the digest the report will carry verbatim as
 * `reviewedDiffDigest`, and the ONLY workspace paths the run touched. Discovery pinned by T10:
 * `ReviewReportSchema` carries the diff's digest but no path list, so this descriptor is the sole
 * source for finding-location scoping — the model may not attribute a finding to a file the run
 * never touched.
 */
export interface ReviewedDiffDescriptor {
  readonly digest: string;
  readonly paths: readonly string[];
}

/**
 * The reviewer's typed inputs (plan Task 10, review finding 2b): the exact plan and verification
 * report the review binds to, plus the reviewed diff descriptor. The documents are admitted by the
 * role BEFORE the model call; `context` entries are untyped blobs a composer may carry along
 * (an implementer transcript, for instance) and the review role NEVER renders them — spec §8.2
 * requires a session isolated from the implementer's hidden reasoning, so isolation is structural
 * rather than filtered by name.
 */
export interface ReviewRoleDocuments {
  readonly kind: "review_documents";
  readonly plan: PlanDocument;
  readonly verification: VerificationReport;
  readonly reviewedDiff: ReviewedDiffDescriptor;
  readonly context?: readonly NativeRoleInput[];
}

/**
 * Per-invocation role inputs, discriminated by `Array.isArray`: the bare-array arm is the plain
 * `{label, content}` context form (triage and plan), and the object arm is the reviewer's typed
 * documents. The array arm is deliberately the pre-T10 provider shape, so existing composition
 * wiring keeps compiling unchanged.
 */
export type NativeRoleInputs = readonly NativeRoleInput[] | ReviewRoleDocuments;

export const isReviewRoleDocuments = (inputs: NativeRoleInputs): inputs is ReviewRoleDocuments =>
  !Array.isArray(inputs) && "kind" in inputs && inputs.kind === "review_documents";
