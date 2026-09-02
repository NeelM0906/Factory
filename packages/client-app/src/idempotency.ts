/** Options for {@link createIdempotencyKeyFactory}. */
export interface CreateIdempotencyKeyFactoryOptions {
  /** Injected UUID source. Defaults to `globalThis.crypto.randomUUID`. Never called at module scope. */
  readonly randomUUID?: () => string;
}

/**
 * Steer/cancel key factory — **only**. D2 rules that approval-decision idempotency is derived by
 * the server from `(approvalId, decision, evidenceDigest)` and that the server ignores any
 * client-supplied `Idempotency-Key` header on that route, so there is deliberately no decision-key
 * counterpart here: `decideApproval` in `api-client.ts` sends no `Idempotency-Key` header at all.
 *
 * Steering and cancelling a run are intent, not a decision over specific evidence — re-issuing one
 * is a new instruction and must not be replayed — so every call to the returned factory mints a
 * fresh key.
 */
export function createIdempotencyKeyFactory(
  options: CreateIdempotencyKeyFactoryOptions = {}
): () => string {
  const randomUUID = options.randomUUID ?? (() => globalThis.crypto.randomUUID());
  return () => randomUUID();
}
