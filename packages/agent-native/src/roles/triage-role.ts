import { TriageReportSchema, type TriageReport } from "@autostack/contracts";
import { z } from "zod";

import { admitTriageEvidence, digestTriageEvidence } from "../evidence.js";
import { NATIVE_PROMPTS } from "../prompts/index.js";
import { pickModelAuthoredShape } from "../prompts/prompt-artifact.js";
import type { NativeRoleConfig, NativeRoleDocumentInput } from "./role-config.js";

const TRIAGE_PROMPT = NATIVE_PROMPTS.triage;

/** The ceiling the triage role declares for one structured response (plan Task 8). */
const TRIAGE_MAX_OUTPUT_TOKENS = 8_192;

/** Reads the duplicate references out of a candidate model response without trusting its shape. */
const duplicateReferencesOf = (value: unknown): readonly string[] => {
  if (value === null || typeof value !== "object") {
    return [];
  }
  const duplicates: unknown = Reflect.get(value, "duplicates");
  if (!Array.isArray(duplicates)) {
    return [];
  }
  const entries: readonly unknown[] = duplicates;
  const references: string[] = [];
  for (const entry of entries) {
    if (entry !== null && typeof entry === "object") {
      const reference: unknown = Reflect.get(entry, "reference");
      if (typeof reference === "string") {
        references.push(reference);
      }
    }
  }
  return references;
};

/**
 * The model-authored subset of `TriageReportSchema`, with the report's object-level duplicates
 * refinement carried over. `pickModelAuthoredShape` rebuilds from the schema's `.shape`, which
 * drops object-level refinements — without re-adding this one, a duplicated reference would slip
 * past structured-output admission and surface later as an internal error from the full-document
 * parse instead of as `malformed_model_output` with a repair channel (T8 lead ruling).
 */
const TriageModelAuthoredSchema = pickModelAuthoredShape(
  TriageReportSchema.shape,
  TRIAGE_PROMPT.modelAuthoredFields
).superRefine((value, context) => {
  const references = duplicateReferencesOf(value);
  if (new Set(references).size !== references.length) {
    context.addIssue({
      code: "custom",
      path: ["duplicates"],
      message: "A duplicate reference may only be reported once."
    });
  }
});

const ModelAuthoredRecordSchema = z.record(z.string(), z.unknown());

/**
 * Builds the full triage report: identity from the INVOCATION, content from the admitted model
 * fields, provenance from the harness. Harness-owned fields are written after the spread, so even
 * a model value that somehow bypassed the strict output schema could never supply identity.
 */
const buildTriageReport = (input: NativeRoleDocumentInput): TriageReport =>
  TriageReportSchema.parse({
    ...ModelAuthoredRecordSchema.parse(input.modelAuthored),
    schemaVersion: 1,
    workspaceId: input.identity.workspaceId,
    workItemId: input.identity.workItemId,
    runId: input.identity.runId,
    producedAt: input.producedAt,
    producedBy: input.producedBy
  });

/**
 * The triage role as data (plan Task 8): stage `"triage"`, capabilities
 * `["text", "structured_output"]`, and an evidence pipeline that delegates to the contracts
 * helpers via `evidence.ts` — `digestTriageReport` (which INCLUDES `producedBy`, the 0.12 ruling)
 * and the two-argument `admitTriageReport`.
 */
export const TRIAGE_ROLE_CONFIG: NativeRoleConfig<TriageReport> = Object.freeze({
  role: "triage",
  prompt: TRIAGE_PROMPT,
  stage: "triage",
  requiredCapabilities: Object.freeze(["text", "structured_output"]),
  maxOutputTokens: TRIAGE_MAX_OUTPUT_TOKENS,
  outputSchema: TriageModelAuthoredSchema,
  buildDocument: buildTriageReport,
  digestDocument: digestTriageEvidence,
  admitDocument: admitTriageEvidence
});
