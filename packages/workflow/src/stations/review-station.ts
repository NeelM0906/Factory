/**
 * The `pipeline.review` handler (spec §8.2, plan Task 12): runs an isolated review harness session
 * in a separate environment, produces a ReviewReport, and emits ReviewEvidence. An approved review
 * advances to publishing; changes_requested reworks to implement within the bounded attempt budget.
 *
 * Stub — full implementation follows.
 */

import type { WorkflowHandlerContext, WorkflowHandlerResult } from "../handler-registry.js";
import type { ProjectExecutionConfiguration } from "./execution-scope.js";
import type { PipelineJobPayload } from "./pipeline-job.js";
import type { StationDependencies } from "./station-context.js";

export const runReviewStation = async (
  _payload: PipelineJobPayload,
  _context: WorkflowHandlerContext,
  _dependencies: StationDependencies,
  _configuration: ProjectExecutionConfiguration
): Promise<WorkflowHandlerResult> => {
  throw new Error("Not implemented yet.");
};
