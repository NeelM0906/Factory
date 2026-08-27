import { z } from "zod";

/**
 * The failure-code alphabet every failure surface normalizes to: lowercase snake_case, at most 64
 * characters. Shared so agent-side codes are required to survive the normalization unchanged.
 */
export const WorkflowFailureCodeSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,63}$/);

export const WorkflowFailureSchema = z
  .object({
    code: WorkflowFailureCodeSchema,
    name: z.string().trim().min(1).max(160),
    message: z.string().trim().min(1).max(2_000),
    retryable: z.boolean()
  })
  .strict();

export type WorkflowFailureCode = z.infer<typeof WorkflowFailureCodeSchema>;
export type WorkflowFailure = z.infer<typeof WorkflowFailureSchema>;

/**
 * Lifts a candidate code into the failure alphabet, or refuses. The rule is
 * **unchanged-acceptance**: a code is admitted only if it is already exactly what the alphabet
 * accepts, so nothing is coerced, trimmed, lowercased, or rewritten on the way in.
 *
 * The sharp edge this exists to close: `WorkflowFailureCodeSchema` carries `.trim()`, so
 * `" rate_limited"` parses *successfully* — to a different string. An implementation that returned
 * `parsed.data` whenever parsing succeeded would ship trim-then-accept, which is a different rule
 * from the one the pipeline branches on, and would conjure a code the stream never carried. Hence
 * the strict-equality check against the untrimmed input.
 *
 * Returning `undefined` rather than throwing or substituting is deliberate: what to do with a code
 * that cannot be lifted is the consumer's decision — a classifier may map it, a conformance suite
 * may fail the adapter that emitted it — and this helper is only the shared rule they agree on.
 */
export const normalizeWorkflowFailureCode = (
  candidate: string
): WorkflowFailureCode | undefined => {
  const parsed = WorkflowFailureCodeSchema.safeParse(candidate);
  return parsed.success && parsed.data === candidate ? parsed.data : undefined;
};
