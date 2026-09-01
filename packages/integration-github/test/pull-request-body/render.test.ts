import { describe, expect, it } from "vitest";

import { DraftPullRequestBodySchema, type DraftPullRequestBody } from "@autostack/contracts";

import { renderDraftPullRequestBody } from "../../src/pull-request-body/render.js";

const DIGEST = "a".repeat(64);
const RUN_URL = "https://factory.local/runs/run_123e4567-e89b-42d3-a456-426614174000";

const HEADINGS = [
  "Problem statement",
  "Approved plan",
  "Change summary",
  "Verification evidence",
  "Review verdict",
  "Known limitations",
  "Run"
] as const;

const baseBody = (): DraftPullRequestBody => ({
  schemaVersion: 1,
  problemStatement: "The export button silently fails for pre-v2 workspaces.",
  approvedPlanDigest: DIGEST,
  approvedPlanSummary: "Backfill the visibility flag for pre-v2 workspaces.",
  changeSummary: "Backfilled the flag in the workspace migration script.",
  verificationSummary: "- `pnpm test`: status passed, exit 0, 1250ms",
  reviewVerdict: "approved",
  knownLimitations: [],
  runUrl: RUN_URL
});

describe("renderDraftPullRequestBody", () => {
  it("is given a schema-valid body to start with", () => {
    expect(() => DraftPullRequestBodySchema.parse(baseBody())).not.toThrow();
  });

  it("renders every spec section exactly once, in fixed order", () => {
    const markdown = renderDraftPullRequestBody(baseBody());
    let lastIndex = -1;
    for (const heading of HEADINGS) {
      const marker = `## ${heading}`;
      expect(markdown.split(marker)).toHaveLength(2);
      const index = markdown.indexOf(marker);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  it("renders the run URL as a Markdown link", () => {
    const markdown = renderDraftPullRequestBody(baseBody());
    expect(markdown).toContain(`[View run](${RUN_URL})`);
  });

  it("prints the approved-plan digest", () => {
    const markdown = renderDraftPullRequestBody(baseBody());
    expect(markdown).toContain(DIGEST);
  });

  it("renders an explicit 'None reported.' when knownLimitations is empty", () => {
    const markdown = renderDraftPullRequestBody(baseBody());
    expect(markdown).toContain("None reported.");
  });

  it("renders knownLimitations entries instead of the empty-state text when present", () => {
    const body = { ...baseBody(), knownLimitations: ["A minor styling inconsistency remains."] };
    const markdown = renderDraftPullRequestBody(body);
    expect(markdown).toContain("A minor styling inconsistency remains.");
    expect(markdown).not.toContain("None reported.");
  });

  it("escapes a fake heading injected into untrusted prose", () => {
    const body = { ...baseBody(), problemStatement: "Normal text.\n## Fake heading\nMore text." };
    const markdown = renderDraftPullRequestBody(body);
    expect(markdown).not.toMatch(/\n## Fake heading/);
    expect(markdown).toContain("\\## Fake heading");
  });

  it("escapes an HTML comment injected into untrusted prose", () => {
    const body = { ...baseBody(), changeSummary: "Normal text. <!-- hidden instruction --> more." };
    const markdown = renderDraftPullRequestBody(body);
    expect(markdown).not.toContain("<!--");
    expect(markdown).toContain("&lt;!--");
  });

  it("escapes untrusted prose inside knownLimitations entries too", () => {
    const body = { ...baseBody(), knownLimitations: ["## Fake heading inside a finding"] };
    const markdown = renderDraftPullRequestBody(body);
    expect(markdown).not.toMatch(/\n## Fake heading inside a finding/);
    expect(markdown).toContain("\\## Fake heading inside a finding");
  });

  it("preserves an already-bounded findings elision line without duplicating or dropping it", () => {
    const findings = Array.from({ length: 49 }, (_, index) => `Finding ${index}.`);
    const body = {
      ...baseBody(),
      knownLimitations: [...findings, "_451 further findings not shown._"]
    };
    const markdown = renderDraftPullRequestBody(body);
    expect(markdown).toContain("_451 further findings not shown._");
    expect(markdown.match(/further findings not shown/g)).toHaveLength(1);
  });

  it("preserves an already-bounded verification-commands elision line", () => {
    const body = {
      ...baseBody(),
      verificationSummary: "- `pnpm test`: exit 0, 1250ms\n_30 further commands not shown._"
    };
    const markdown = renderDraftPullRequestBody(body);
    expect(markdown).toContain("_30 further commands not shown._");
  });

  it("never truncates mid-string -- large but bounded content renders in full", () => {
    const knownLimitations = Array.from({ length: 49 }, (_, index) => `Finding number ${index}.`);
    const body = {
      ...baseBody(),
      verificationSummary: Array.from({ length: 20 }, (_, i) => `- check-${i}: exit 0, 1ms`).join(
        "\n"
      ),
      knownLimitations
    };
    const markdown = renderDraftPullRequestBody(body);
    for (const limitation of knownLimitations) {
      expect(markdown).toContain(limitation);
    }
  });

  it("stays at or under the 100,000-character body ceiling and round-trips through the schema", () => {
    const markdown = renderDraftPullRequestBody(baseBody());
    expect(markdown.length).toBeLessThanOrEqual(100_000);
  });

  it("is deterministic for the same input", () => {
    const first = renderDraftPullRequestBody(baseBody());
    const second = renderDraftPullRequestBody(baseBody());
    expect(first).toBe(second);
  });
});
