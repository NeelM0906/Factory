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

export type WorkflowFailure = z.infer<typeof WorkflowFailureSchema>;
