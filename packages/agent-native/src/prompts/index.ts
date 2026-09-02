import { PLAN_PROMPT } from "./plan-prompt.js";
import { deepFreeze, type NativeAgentRole, type NativePromptArtifact } from "./prompt-artifact.js";
import { REVIEW_PROMPT } from "./review-prompt.js";
import { TRIAGE_PROMPT } from "./triage-prompt.js";

export {
  NATIVE_AGENT_ROLES,
  UNTRUSTED_INPUT_BLOCK_CLOSE,
  UNTRUSTED_INPUT_BLOCK_OPEN
} from "./prompt-artifact.js";
export type {
  NativeAgentRole,
  NativePromptArtifact,
  NativePromptRenderInput
} from "./prompt-artifact.js";
export { PROMPT_DIGESTS, PROMPT_SAMPLE_INPUTS, type PromptDigestRow } from "./prompt-digests.js";

/** The prompt registry: one artifact per role, exhaustive over `NATIVE_AGENT_ROLES`. */
export const NATIVE_PROMPTS: Readonly<Record<NativeAgentRole, NativePromptArtifact>> = deepFreeze({
  triage: TRIAGE_PROMPT,
  plan: PLAN_PROMPT,
  review: REVIEW_PROMPT
});
