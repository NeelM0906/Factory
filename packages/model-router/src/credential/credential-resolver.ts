import type { CredentialRef, CredentialRefId } from "@autostack/contracts";

import type { CredentialResolver } from "../catalog/catalog-types.js";
import type { CredentialRefStore } from "../credential-ref-store.js";

/**
 * DEC-6: the join between the two credential shapes Tasks 3/10 and Task 11 landed. Consumers
 * (catalog discovery, the language-model factory) can only supply a bare `CredentialRefId` — that
 * is the only shape `ModelTransportSchema` carries. `CredentialRefStore` can only take a whole
 * `CredentialRef` — its on-disk filename is a digest of `store` + `locator`, so an id alone cannot
 * address a stored secret. Composition supplies this registry as data (id -> full ref); it is not
 * discovered or inferred here.
 */
export interface CredentialRefRegistry {
  get(credentialRefId: CredentialRefId): CredentialRef | undefined;
}

export interface CreateCredentialResolverOptions {
  readonly registry: CredentialRefRegistry;
  readonly store: CredentialRefStore;
}

/**
 * Implements `CredentialResolver` over `CredentialRefStore` by looking a `CredentialRefId` up in
 * `registry` and delegating to `store`. This adapter is the only thing in the package that knows
 * both credential shapes, which is what keeps the two-call-site invariant (catalog discovery, the
 * language-model factory) intact.
 *
 * An id absent from the registry fails closed with the same "unknown credential reference" shape
 * the store itself raises for an unresolvable ref (`credential-ref-store.ts`'s `#readEncrypted`) —
 * it never falls through to an unauthenticated request by returning an empty value or skipping
 * resolution, and the store is never called with a fabricated or partial ref.
 */
export const createCredentialResolver = (
  options: CreateCredentialResolverOptions
): CredentialResolver => ({
  resolve: async (credentialRefId: CredentialRefId): Promise<string> => {
    const ref = options.registry.get(credentialRefId);
    if (ref === undefined) {
      throw new Error(`unknown credential reference: ${credentialRefId}`);
    }
    return options.store.resolve(ref);
  }
});
