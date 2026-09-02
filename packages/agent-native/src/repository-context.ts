import { redactSensitiveText } from "@autostack/contracts";

import type { AssembledContext } from "./context-assembly.js";
import {
  isReviewRoleDocuments,
  type NativeRoleInput,
  type NativeRoleInputs,
  type ReviewRoleDocuments
} from "./roles/role-inputs.js";

/** Plain `{label, content}` context entries, rendered verbatim under redaction (triage, plan). */
const renderContextEntries = (inputs: readonly NativeRoleInput[]): readonly string[] =>
  inputs.map((input) => `## Upstream input: ${input.label}\n${redactSensitiveText(input.content)}`);

/**
 * The reviewer's rendered upstream context derives EXCLUSIVELY from the ADMITTED typed documents:
 * the plan's approved content, the verification results, and the reviewed diff's scope. `context`
 * entries are dropped by design, not by name-filtering — spec §8.2 requires a session isolated
 * from the implementer's hidden reasoning, so an implementer transcript a composer carries along
 * is structurally unrenderable here.
 */
const renderReviewDocuments = (documents: ReviewRoleDocuments): readonly string[] => {
  const { plan, verification, reviewedDiff } = documents;
  return [
    [
      `## Approved plan (planDigest ${plan.planDigest})`,
      redactSensitiveText(plan.summary),
      ...plan.acceptanceCriteria.map(
        (criterion) => `- Acceptance: ${redactSensitiveText(criterion)}`
      )
    ].join("\n"),
    [
      `## Verification report (status ${verification.status})`,
      ...verification.results.map(
        (result) =>
          `- ${redactSensitiveText([result.command.executable, ...result.command.args].join(" "))}: ${result.status}${result.exitCode === undefined ? "" : ` (exit ${String(result.exitCode)})`}`
      )
    ].join("\n"),
    [
      `## Reviewed diff (digest ${reviewedDiff.digest})`,
      ...reviewedDiff.paths.map((path) => `- ${path}`)
    ].join("\n")
  ];
};

/** Assembles the untrusted repository-context block the role's prompt fences and renders. */
export const buildRepositoryContext = (
  assembled: AssembledContext,
  inputs: NativeRoleInputs,
  steerText: string | undefined
): string => {
  const sections: string[] = [
    ...(isReviewRoleDocuments(inputs)
      ? renderReviewDocuments(inputs)
      : renderContextEntries(inputs))
  ];
  for (const file of assembled.files) {
    sections.push(`## Workspace file: ${file.path}\n${file.content}`);
  }
  for (const omission of assembled.omissions) {
    sections.push(`## Context omitted: ${omission.path} (${omission.reason})`);
  }
  for (const truncation of assembled.truncations) {
    sections.push(`## Context truncated: ${truncation.path} (${truncation.reason})`);
  }
  if (steerText !== undefined) {
    sections.push(`## Operator steering\n${steerText}`);
  }
  return sections.join("\n\n");
};
