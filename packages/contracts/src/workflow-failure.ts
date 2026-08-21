import { z } from "zod";

export const WorkflowFailureSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{0,63}$/),
    name: z.string().trim().min(1).max(160),
    message: z.string().trim().min(1).max(2_000),
    retryable: z.boolean()
  })
  .strict();

export type WorkflowFailure = z.infer<typeof WorkflowFailureSchema>;
