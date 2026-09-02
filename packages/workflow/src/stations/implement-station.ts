/**
 * The `pipeline.implement` handler (spec §8.2, plan Task 9): provisions an environment using the
 * recorded authorization, starts a harness session against the approved plan, and commits the
 * implementation to the autostack-prefixed branch. Emits `ImplementationEvidence` binding the plan
 * approval, source commit, result commit, and diff digest.
 *
 * Stub — full implementation follows.
 */

import type { WorkflowHandlerContext, WorkflowHandlerResult } from "../handler-registry.js";
import type { ProjectExecutionConfiguration } from "./execution-scope.js";
import type { PipelineJobPayload } from "./pipeline-job.js";
import type { StationDependencies } from "./station-context.js";

export const runImplementStation = async (
  _payload: PipelineJobPayload,
  _context: WorkflowHandlerContext,
  _dependencies: StationDependencies,
  _configuration: ProjectExecutionConfiguration
): Promise<WorkflowHandlerResult> => {
  throw new Error("Not implemented yet.");
};
