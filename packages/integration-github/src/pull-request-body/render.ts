import { SafeMetadataStringSchema, type DraftPullRequestBody } from "@autostack/contracts";

/** Matches `DraftPullRequestRequestSchema.body`'s ceiling (spec §4.4). */
const MAX_BODY_LENGTH = 100_000;

/**
 * Neutralizes the two markdown injection vectors called out for PR bodies (spec §14.1, acceptance
 * criterion 16): a fake `##` heading that could impersonate a real section, and an HTML comment
 * (`<!-- ... -->`) that GitHub renders as invisible. Escaping every `<` also neutralizes any other
 * HTML tag, not only comments.
 */
const escapeUntrustedProse = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.replace(/</g, "&lt;").replace(/^(\s*)(#{1,6})(\s)/, "$1\\$2$3"))
    .join("\n");

const renderKnownLimitations = (
  knownLimitations: DraftPullRequestBody["knownLimitations"]
): string =>
  knownLimitations.length === 0
    ? "None reported."
    : knownLimitations.map((item) => `- ${escapeUntrustedProse(item)}`).join("\n");

/**
 * Renders the seven spec §4.4 sections as Markdown, in fixed order, under stable `##` headings.
 * The renderer never truncates: `composeDraftPullRequestBody` is responsible for bounding
 * `verificationSummary` and `knownLimitations` to fit the contract schema (a plan's commands and a
 * review's findings can each be far more numerous than the body has room for), so by the time a
 * `DraftPullRequestBody` reaches here any elision line it carries is already correct -- this function
 * only has to display it faithfully, without adding a second one or cutting it off.
 */
export const renderDraftPullRequestBody = (body: DraftPullRequestBody): string => {
  const sections: ReadonlyArray<readonly [string, string]> = [
    ["Problem statement", escapeUntrustedProse(body.problemStatement)],
    [
      "Approved plan",
      `Digest: \`${body.approvedPlanDigest}\`\n\n${escapeUntrustedProse(body.approvedPlanSummary)}`
    ],
    ["Change summary", escapeUntrustedProse(body.changeSummary)],
    ["Verification evidence", escapeUntrustedProse(body.verificationSummary)],
    ["Review verdict", body.reviewVerdict],
    ["Known limitations", renderKnownLimitations(body.knownLimitations)],
    ["Run", `[View run](${body.runUrl})`]
  ];

  const markdown = `${sections.map(([heading, content]) => `## ${heading}\n\n${content}`).join("\n\n")}\n`;

  return SafeMetadataStringSchema.max(MAX_BODY_LENGTH).parse(markdown);
};
