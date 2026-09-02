import {
  deepFreeze,
  type NativeAgentRole,
  type NativePromptRenderInput
} from "./prompt-artifact.js";

/** One row of the append-only prompt digest table. */
export interface PromptDigestRow {
  readonly promptRef: string;
  readonly version: number;
  readonly digest: string;
}

/**
 * Frozen sample inputs the digest table pins each prompt's rendering against. Never edit an
 * existing sample: every shipped version's digest was taken over the rendering of exactly this
 * input, so editing one silently invalidates history instead of catching a prompt edit.
 */
export const PROMPT_SAMPLE_INPUTS: Readonly<Record<NativeAgentRole, NativePromptRenderInput>> =
  deepFreeze({
    triage: {
      objective: "Users report the checkout total is wrong after applying a discount code.",
      repositoryContext: "A pnpm workspace; the checkout service lives in packages/checkout."
    },
    plan: {
      objective: "Fix the discount rounding defect in the checkout total.",
      repositoryContext: "A pnpm workspace; the checkout service lives in packages/checkout."
    },
    review: {
      objective: "Review the prepared fix for the discount rounding defect.",
      repositoryContext: "A pnpm workspace; the checkout service lives in packages/checkout."
    }
  });

/**
 * Append-only version pins (spec §16.2). Each digest is
 * `digestVersionedValue("autostack.native-prompt", { promptRef, version, system, renderedSample })`
 * where `renderedSample` is the artifact's `render` applied to its `PROMPT_SAMPLE_INPUTS` entry.
 * Never edit an existing row: a prompt change ships as a new version with a new appended row, and
 * an edit without a version bump fails the recompute-equals-row test.
 */
export const PROMPT_DIGESTS: readonly PromptDigestRow[] = deepFreeze([
  {
    promptRef: "autostack.native.triage",
    version: 1,
    digest: "58e6eaa6768a6c4300729a42648c62df92d4c2600caba11e7247ae04fda522b6"
  },
  {
    promptRef: "autostack.native.plan",
    version: 1,
    digest: "a0ce8df1e0b8751c4e05a95e47b856b8830d9e75fe840a085e9ba8457ca06be0"
  },
  {
    promptRef: "autostack.native.review",
    version: 1,
    digest: "3037f4442a2329347cc1cfb3bce9d1b38ec31caa627204ae492c15667f93feec"
  }
]);
