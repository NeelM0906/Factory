import { ModelPolicySchema, type ModelPolicy } from "@autostack/contracts";

/**
 * Pipeline stage 1 (policy admission). Both failure modes here are composition-root programming
 * errors, never conditions a station retries — `TypeError`, not `ModelRoutingError`:
 *
 * - Two policies declaring the same `stage` have no defined constraint between them, and picking
 *   one silently would make behavior depend on array order — rejected at construction.
 * - A `stage` with no configured policy must never fall back to "all routes allowed": a missing
 *   constraint must never be more permissive than any constraint — rejected at the call boundary,
 *   `getForStage`.
 */
export interface PolicyRegistry {
  getForStage(stage: ModelPolicy["stage"]): ModelPolicy;
}

/**
 * Defensive belt-and-suspenders invariant, directly testable in isolation from the registry: a
 * policy's own declared `stage` must match the stage it is being evaluated for. `getForStage`
 * already keys lookups by each policy's own `stage`, so this can only fire if a caller assembles a
 * mismatched `(policy, stage)` pair by hand — still a composition-root error, so `TypeError`.
 */
export const assertPolicyStage = (policy: ModelPolicy, stage: ModelPolicy["stage"]): void => {
  if (policy.stage !== stage) {
    throw new TypeError(
      `Policy "${policy.policyRef}" is configured for stage "${policy.stage}" but was queried for stage "${stage}".`
    );
  }
};

/**
 * Admits every policy through `ModelPolicySchema.parse` and indexes it by its own `stage`. A
 * duplicate `stage` across two policies is rejected here, at construction, rather than at lookup —
 * catching the composition error as early as possible.
 */
export const createPolicyRegistry = (policies: readonly unknown[]): PolicyRegistry => {
  const byStage = new Map<ModelPolicy["stage"], ModelPolicy>();

  policies.forEach((raw, index) => {
    const result = ModelPolicySchema.safeParse(raw);
    if (!result.success) {
      throw new TypeError(`Policy at index ${index} failed validation.`);
    }
    const policy = result.data;
    if (byStage.has(policy.stage)) {
      throw new TypeError(
        `More than one policy is configured for stage "${policy.stage}"; a stage may have exactly one policy.`
      );
    }
    byStage.set(policy.stage, policy);
  });

  return {
    getForStage: (stage) => {
      const policy = byStage.get(stage);
      if (policy === undefined) {
        throw new TypeError(`No policy is configured for stage "${stage}".`);
      }
      assertPolicyStage(policy, stage);
      return policy;
    }
  };
};
