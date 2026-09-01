import {
  ReviewReportSchema,
  admitPlanDocument,
  admitReviewReport,
  admitVerificationReport,
  digestVerificationReport,
  type AgentInvocationRequest,
  type ReviewReport
} from "@autostack/contracts";
import { z } from "zod";

import { NATIVE_AGENT_FAILURES, NativeAgentError, type NativeAgentFailure } from "../errors.js";
import { admitReviewEvidence, digestReviewEvidence } from "../evidence.js";
import { NATIVE_PROMPTS } from "../prompts/index.js";
import { pickModelAuthoredShape } from "../prompts/prompt-artifact.js";
import type { NativeRoleConfig, NativeRoleDocumentInput } from "./role-config.js";
import { isReviewRoleDocuments, type NativeRoleInputs } from "./role-inputs.js";

const REVIEW_PROMPT = NATIVE_PROMPTS.review;

/** The ceiling the review role declares for one structured response (plan Task 10). */
const REVIEW_MAX_OUTPUT_TOKENS = 16_384;

/** What the report will carry as `reviewedDiffDigest`; refused before it can fail the parse. */
const REVIEWED_DIFF_DIGEST_PATTERN = /^[0-9a-f]{64}$/i;

interface CandidateFinding {
  readonly findingRef: string | undefined;
  readonly severity: string | undefined;
  readonly locationPath: string | undefined;
}

/** Reads the findings out of a candidate model response without trusting its shape. */
const findingsOf = (value: unknown): readonly CandidateFinding[] => {
  if (value === null || typeof value !== "object") {
    return [];
  }
  const findings: unknown = Reflect.get(value, "findings");
  if (!Array.isArray(findings)) {
    return [];
  }
  const entries: readonly unknown[] = findings;
  return entries.map((entry) => {
    if (entry === null || typeof entry !== "object") {
      return { findingRef: undefined, severity: undefined, locationPath: undefined };
    }
    const findingRef: unknown = Reflect.get(entry, "findingRef");
    const severity: unknown = Reflect.get(entry, "severity");
    const location: unknown = Reflect.get(entry, "location");
    const path: unknown =
      location !== null && typeof location === "object" ? Reflect.get(location, "path") : undefined;
    return {
      findingRef: typeof findingRef === "string" ? findingRef : undefined,
      severity: typeof severity === "string" ? severity : undefined,
      locationPath: typeof path === "string" ? path : undefined
    };
  });
};

/** Reads the verdict out of a candidate model response without trusting its shape. */
const verdictOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const verdict: unknown = Reflect.get(value, "verdict");
  return typeof verdict === "string" ? verdict : undefined;
};

/**
 * The model-authored subset of `ReviewReportSchema`, with the report's two object-level
 * refinements carried over (T8 lead ruling — `pickModelAuthoredShape` rebuilds from `.shape`,
 * which drops object-level refinements, so without re-adding them here a duplicated findingRef or
 * an approved-with-critical contradiction would slip past structured-output admission and surface
 * later as an internal error from the full-document parse instead of as `malformed_model_output`
 * with a repair channel):
 *
 * - `findingRef` uniqueness — no two findings may share an identifier;
 * - verdict coherence — `approved` may not coexist with a `critical` or `high` finding, and the
 *   role never repairs the verdict in either direction (spec §8.2: a failed review "never
 *   silently marks itself passed", and silently downgrading an approval is the same defect).
 */
const ReviewModelAuthoredSchema = pickModelAuthoredShape(
  ReviewReportSchema.shape,
  REVIEW_PROMPT.modelAuthoredFields
).superRefine((value, context) => {
  const findings = findingsOf(value);
  const findingRefs = findings
    .map((finding) => finding.findingRef)
    .filter((findingRef): findingRef is string => findingRef !== undefined);
  if (new Set(findingRefs).size !== findingRefs.length) {
    context.addIssue({
      code: "custom",
      path: ["findings"],
      message: "Finding identifiers must be unique."
    });
  }
  if (
    verdictOf(value) === "approved" &&
    findings.some((finding) => finding.severity === "critical" || finding.severity === "high")
  ) {
    context.addIssue({
      code: "custom",
      path: ["verdict"],
      message: "Approved reviews cannot contain critical or high findings."
    });
  }
});

/**
 * Pre-model admission of the reviewer's inputs (plan Task 10 Step 1.2-1.3): the typed documents
 * are admitted through the contracts helpers — the plan against its self-digest, the verification
 * report transitively against that plan — and held against the INVOCATION's identity, so the
 * reviewer never reads unadmitted evidence or another run's evidence. Bare `{label, content}`
 * entries are refused outright: untyped blobs cannot be admitted as a plan or a verification
 * report. Every refusal is `native_context_unavailable` — unadmitted context is unavailable
 * context, never a model fault.
 */
const admitReviewRoleInputs = async (
  inputs: NativeRoleInputs,
  invocation: AgentInvocationRequest
): Promise<NativeRoleInputs> => {
  if (!isReviewRoleDocuments(inputs)) {
    throw new NativeAgentError("native_context_unavailable");
  }
  const plan = await admitPlanDocument(inputs.plan);
  const verification = await admitVerificationReport(inputs.verification, plan);
  if (
    plan.workspaceId !== invocation.workspaceId ||
    plan.workItemId !== invocation.workItemId ||
    plan.runId !== invocation.runId
  ) {
    throw new NativeAgentError("native_context_unavailable");
  }
  if (!REVIEWED_DIFF_DIGEST_PATTERN.test(inputs.reviewedDiff.digest)) {
    throw new NativeAgentError("native_context_unavailable");
  }
  return { ...inputs, plan, verification };
};

/**
 * Invocation/input-scoped admission the static output schema cannot express: the reviewed diff's
 * PATHS live on the admitted role inputs (`ReviewReportSchema` carries only the diff's digest), so
 * a finding located outside them is checked here. Location scoping is a SET-membership test over
 * located findings only — a finding may omit its location. The failure is drawn from the frozen
 * table; the model-attributed path is untrusted text and is never echoed into a surfaced message.
 */
const validateReviewModelAuthored = (
  modelAuthored: unknown,
  _invocation: AgentInvocationRequest,
  roleInputs?: NativeRoleInputs
): NativeAgentFailure | undefined => {
  if (roleInputs === undefined || !isReviewRoleDocuments(roleInputs)) {
    const entry = NATIVE_AGENT_FAILURES.native_context_unavailable;
    return {
      code: "native_context_unavailable",
      message: entry.message,
      retryable: entry.retryable
    };
  }
  const reviewedPaths = new Set<string>(roleInputs.reviewedDiff.paths);
  const stray = findingsOf(modelAuthored).some(
    (finding) => finding.locationPath !== undefined && !reviewedPaths.has(finding.locationPath)
  );
  if (!stray) {
    return undefined;
  }
  const entry = NATIVE_AGENT_FAILURES.malformed_model_output;
  return { code: "malformed_model_output", message: entry.message, retryable: entry.retryable };
};

const ModelAuthoredRecordSchema = z.record(z.string(), z.unknown());

/**
 * Builds the full review report: identity from the INVOCATION, content from the admitted model
 * fields, provenance from the harness, and the three binding digests from the ADMITTED role
 * inputs — `planDigest` from the plan's self-digest, `reviewedDiffDigest` from the reviewed diff
 * descriptor verbatim, `verificationReportDigest` recomputed by the contracts helper. Harness-
 * owned fields are written after the spread, so even a model value that somehow bypassed the
 * strict output schema could never supply identity or a binding. The result is put back through
 * the THREE-argument transitive contracts admission before it may exist (lead ruling).
 */
const buildReviewReport = async (input: NativeRoleDocumentInput): Promise<ReviewReport> => {
  const roleInputs = input.roleInputs;
  if (roleInputs === undefined || !isReviewRoleDocuments(roleInputs)) {
    throw new NativeAgentError("native_context_unavailable");
  }
  const plan = await admitPlanDocument(roleInputs.plan);
  const verification = await admitVerificationReport(roleInputs.verification, plan);
  const report = ReviewReportSchema.parse({
    ...ModelAuthoredRecordSchema.parse(input.modelAuthored),
    schemaVersion: 1,
    workspaceId: input.identity.workspaceId,
    workItemId: input.identity.workItemId,
    runId: input.identity.runId,
    planDigest: plan.planDigest,
    reviewedDiffDigest: roleInputs.reviewedDiff.digest,
    verificationReportDigest: await digestVerificationReport(verification),
    producedAt: input.producedAt,
    producedBy: input.producedBy
  });
  return admitReviewReport(report, plan, verification);
};

/**
 * The review role as data (plan Task 10): stage `"isolated_review"` — `ModelRouteContextSchema`
 * has no `"review"` stage, and the name is the point (spec §8.2 requires a session isolated from
 * the implementer's hidden reasoning) — capabilities `["text", "structured_output"]` (the
 * T8-inherited formalization, replacing the interim placeholder pin), and an evidence pipeline
 * over the contracts helpers: `digestReviewReport` (which INCLUDES `producedBy`, the 0.12 ruling —
 * a later reading under a different prompt is a different reading, the exact opposite of the plan
 * rule) and the two-argument registry admission, with the three-argument transitive admission
 * running at `admitRoleInputs` and `buildDocument`, where the upstream inputs live.
 */
export const REVIEW_ROLE_CONFIG: NativeRoleConfig<ReviewReport> = Object.freeze({
  role: "review",
  prompt: REVIEW_PROMPT,
  stage: "isolated_review",
  requiredCapabilities: Object.freeze(["text", "structured_output"]),
  maxOutputTokens: REVIEW_MAX_OUTPUT_TOKENS,
  outputSchema: ReviewModelAuthoredSchema,
  admitRoleInputs: admitReviewRoleInputs,
  validateModelAuthored: validateReviewModelAuthored,
  buildDocument: buildReviewReport,
  digestDocument: digestReviewEvidence,
  admitDocument: admitReviewEvidence
});
