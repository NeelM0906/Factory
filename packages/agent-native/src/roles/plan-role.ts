import {
  PlanDocumentSchema,
  digestPlanDocument,
  type AgentInvocationRequest,
  type PlanDocument
} from "@autostack/contracts";
import { z } from "zod";

import { NATIVE_AGENT_FAILURES, type NativeAgentFailure } from "../errors.js";
import { admitPlanEvidence, digestPlanEvidence } from "../evidence.js";
import { NATIVE_PROMPTS } from "../prompts/index.js";
import { pickModelAuthoredShape } from "../prompts/prompt-artifact.js";
import type {
  NativeRoleConfig,
  NativeRoleDocumentInput,
  NativeRolePlanEvent
} from "./role-config.js";

const PLAN_PROMPT = NATIVE_PROMPTS.plan;

/** The ceiling the plan role declares for one structured response (plan Task 9). */
const PLAN_MAX_OUTPUT_TOKENS = 32_768;

/**
 * Satisfies `PlanDocumentSchema` for the digest pass alone: `canonicalizePlanDocumentForDigest`
 * EXCLUDES the self-field, so the digest of the canonical fields is the same whatever it holds.
 */
const PLACEHOLDER_SELF_DIGEST = "0".repeat(64);

/**
 * Shell metacharacters (word separators, operators, expansions, quoting) that have no meaning in
 * a direct `execve`-style invocation. Their presence in `executable` is only honest when the
 * command DECLARES `usesShell: true` — the refinement below keys on that declaration and never
 * blanket-bans the characters themselves.
 */
const SHELL_SYNTAX_PATTERN = /[\s"'#$&()*;<>?\\`|~]/;

interface CandidateVerificationCommand {
  readonly index: number;
  readonly executable: string | undefined;
  readonly usesShell: boolean | undefined;
  readonly required: boolean | undefined;
}

/** Reads the verification commands out of a candidate model response without trusting its shape. */
const verificationCommandsOf = (value: unknown): readonly CandidateVerificationCommand[] => {
  if (value === null || typeof value !== "object") {
    return [];
  }
  const commands: unknown = Reflect.get(value, "verificationCommands");
  if (!Array.isArray(commands)) {
    return [];
  }
  const entries: readonly unknown[] = commands;
  return entries.map((entry, index) => {
    if (entry === null || typeof entry !== "object") {
      return { index, executable: undefined, usesShell: undefined, required: undefined };
    }
    const executable: unknown = Reflect.get(entry, "executable");
    const usesShell: unknown = Reflect.get(entry, "usesShell");
    const required: unknown = Reflect.get(entry, "required");
    return {
      index,
      executable: typeof executable === "string" ? executable : undefined,
      usesShell: typeof usesShell === "boolean" ? usesShell : undefined,
      required: typeof required === "boolean" ? required : undefined
    };
  });
};

/**
 * The model-authored subset of `PlanDocumentSchema`, with two object-level refinements the
 * narrowed schema must carry (T8 lead ruling — `pickModelAuthoredShape` rebuilds from `.shape`,
 * which drops object-level refinements, and `PlanDocumentSchema` is deliberately permissive about
 * shell syntax, so both rules would otherwise slip past structured-output admission):
 *
 * - at least one `required: true` verification command, carried over from the contract schema so
 *   the rejection classifies as `malformed_model_output` with the repair channel intact, never as
 *   an internal error from the full-document parse — and never "repaired" by promoting a command;
 * - usesShell honesty: a command that smuggles shell syntax into `executable` while declaring
 *   `usesShell: false` is a lie about what will execute and is refused; the SAME string under
 *   `usesShell: true` is an honest shell command and admits.
 */
const PlanModelAuthoredSchema = pickModelAuthoredShape(
  PlanDocumentSchema.shape,
  PLAN_PROMPT.modelAuthoredFields
).superRefine((value, context) => {
  const commands = verificationCommandsOf(value);
  if (commands.length > 0 && !commands.some((command) => command.required === true)) {
    context.addIssue({
      code: "custom",
      path: ["verificationCommands"],
      message: "A plan must name at least one required verification command."
    });
  }
  for (const command of commands) {
    if (
      command.usesShell === false &&
      command.executable !== undefined &&
      SHELL_SYNTAX_PATTERN.test(command.executable)
    ) {
      context.addIssue({
        code: "custom",
        path: ["verificationCommands", command.index, "executable"],
        message: "A command that declares usesShell false cannot carry shell syntax in executable."
      });
    }
  }
});

const ModelAuthoredRecordSchema = z.record(z.string(), z.unknown());

/**
 * Builds the full plan document: identity from the INVOCATION, content from the admitted model
 * fields, provenance from the harness. Harness-owned fields are written after the spread, so even
 * a model value that somehow bypassed the strict output schema could never supply identity or the
 * self-digest. Async because the self-`planDigest` is computed here — by `digestPlanDocument`
 * over the canonical fields, never by a local rule — and written INTO the returned document.
 */
const buildPlanDocument = async (input: NativeRoleDocumentInput): Promise<PlanDocument> => {
  const candidate = PlanDocumentSchema.parse({
    ...ModelAuthoredRecordSchema.parse(input.modelAuthored),
    schemaVersion: 1,
    workspaceId: input.identity.workspaceId,
    workItemId: input.identity.workItemId,
    runId: input.identity.runId,
    producedAt: input.producedAt,
    producedBy: input.producedBy,
    planDigest: PLACEHOLDER_SELF_DIGEST
  });
  const planDigest = await digestPlanDocument(candidate);
  return PlanDocumentSchema.parse({ ...candidate, planDigest });
};

/**
 * The registry admission gate keeps the two-argument shape: the document must admit through the
 * ONE-argument contracts admission (digest recomputed from canonical fields) AND carry exactly
 * the digest the completion recorded, so neither a tampered document nor a stale recording passes.
 */
const admitPlanRoleDocument = async (
  document: unknown,
  expectedDigest: string
): Promise<PlanDocument> => {
  const admitted = await admitPlanEvidence(document);
  if (admitted.planDigest !== expectedDigest) {
    throw new TypeError("Plan document does not match the digest it was recorded under.");
  }
  return admitted;
};

/** Reads the requested credential refs out of a candidate response without trusting its shape. */
const requestedCredentialRefIdsOf = (value: unknown): readonly string[] => {
  if (value === null || typeof value !== "object") {
    return [];
  }
  const refs: unknown = Reflect.get(value, "requiredCredentialRefIds");
  if (!Array.isArray(refs)) {
    return [];
  }
  const entries: readonly unknown[] = refs;
  return entries.filter((entry): entry is string => typeof entry === "string");
};

/**
 * Invocation-scoped admission the static output schema cannot express: the invocation's
 * `credentialRefIds` (contract default `[]`) is the run's authorized set, and a plan may REQUEST
 * a credential but never widen that grant. The failure is drawn from the frozen table — the
 * widened refs are model-supplied text and are never echoed into a surfaced message.
 */
const validatePlanModelAuthored = (
  modelAuthored: unknown,
  invocation: AgentInvocationRequest
): NativeAgentFailure | undefined => {
  const authorized = new Set<string>(invocation.credentialRefIds);
  const widened = requestedCredentialRefIdsOf(modelAuthored).filter((ref) => !authorized.has(ref));
  if (widened.length === 0) {
    return undefined;
  }
  const entry = NATIVE_AGENT_FAILURES.malformed_model_output;
  return { code: "malformed_model_output", message: entry.message, retryable: entry.retryable };
};

/** The `plan` detail event the admitted document announces: its self-digest and its summary. */
const planEventOf = (document: PlanDocument): NativeRolePlanEvent => ({
  planDigest: document.planDigest,
  summary: document.summary
});

/**
 * The plan role as data (plan Task 9): stage `"plan"`, capabilities
 * `["text", "structured_output"]` (the T8-inherited formalization, replacing the interim
 * placeholder pin), and an evidence pipeline over the contracts helpers — `digestPlanDocument`
 * (which EXCLUDES `producedBy`, the 0.12 ruling: a prompt bump must not revoke an outstanding
 * plan approval) and the ONE-argument `admitPlanDocument`. The only role declaring a plan event.
 */
export const PLAN_ROLE_CONFIG: NativeRoleConfig<PlanDocument> = Object.freeze({
  role: "plan",
  prompt: PLAN_PROMPT,
  stage: "plan",
  requiredCapabilities: Object.freeze(["text", "structured_output"]),
  maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS,
  outputSchema: PlanModelAuthoredSchema,
  buildDocument: buildPlanDocument,
  digestDocument: digestPlanEvidence,
  admitDocument: admitPlanRoleDocument,
  validateModelAuthored: validatePlanModelAuthored,
  planEvent: planEventOf
});
