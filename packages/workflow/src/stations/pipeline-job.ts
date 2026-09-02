import { PipelineStageSchema, WorkItemIdSchema } from "@autostack/contracts";
import { z } from "zod";

const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/i);

/**
 * The payload every delivery station handler registers with, and the only thing the handler
 * registry parses before a station runs. Strict: the leased job already carries `workspaceId`,
 * `runId`, and `stage`, so repeating any of them here would be a second source of run identity.
 *
 * `attempt` is the **implement-rework counter** (plan F4/D4) — how many times a failed judgement
 * has sent this run back to implement, bounded by `PIPELINE_REWORK_MAX_ATTEMPTS`. It is not
 * `LeasedWorkflowJob.attempt`, which counts transient lease retries of one job and resets nothing.
 * Conflating them would let a retried job spend a rework budget it never used.
 */
export const PipelineJobPayloadSchema = z
  .object({
    workItemId: WorkItemIdSchema,
    pipelineStage: PipelineStageSchema,
    attempt: z.number().int().positive(),
    inputEvidenceDigests: z.array(DigestSchema).max(100)
  })
  .strict();

export type PipelineJobPayload = z.infer<typeof PipelineJobPayloadSchema>;
