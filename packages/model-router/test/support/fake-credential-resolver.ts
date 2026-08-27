import type { CredentialRefId } from "@autostack/contracts";

/**
 * The seam both legitimate credential call sites depend on (catalog discovery and the language-model
 * factory — see the plan's architecture section). Declared here rather than imported because no
 * production module has assembled it yet; `src/catalog/catalog-types.ts` re-declares the same shape
 * for production code, and the two are structurally identical by construction.
 */
export interface CredentialResolver {
  resolve(credentialRefId: CredentialRefId): Promise<string>;
}

/** A secret shaped distinctly enough that a test (or a later credential-shaped sweep) can spot it. */
const FIXTURE_SECRET_PREFIX = "sk-fixture-secret-for-";

export interface FakeCredentialResolver extends CredentialResolver {
  /** Every resolved ref, in call order — the source of truth for "how many times, at which ref". */
  readonly calls: readonly CredentialRefId[];
  /** How many times this exact ref was resolved. */
  countFor(credentialRefId: CredentialRefId): number;
}

/**
 * Returns a recognizable fixture secret per `CredentialRefId` and counts resolutions, so a test can
 * assert both "resolved exactly once for this route" and, summed across a whole scenario, "exactly
 * two credential call sites exist" (discovery and the language-model factory — finding 3).
 */
export const createFakeCredentialResolver = (): FakeCredentialResolver => {
  const calls: CredentialRefId[] = [];

  return {
    calls,
    resolve: (credentialRefId: CredentialRefId): Promise<string> => {
      calls.push(credentialRefId);
      return Promise.resolve(`${FIXTURE_SECRET_PREFIX}${credentialRefId}`);
    },
    countFor: (credentialRefId: CredentialRefId): number =>
      calls.filter((call) => call === credentialRefId).length
  };
};
