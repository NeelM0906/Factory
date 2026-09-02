/**
 * The `pipeline.verify` handler (spec §8.2, plan Task 11): executes exactly the plan's
 * verification commands, in order, using Task 7's authorizations. Constructs a VerificationReport
 * with results, emits VerificationEvidence, and routes to reviewing or back to implement on failure.
 *
 * Stub — full implementation follows.
 */

import type { WorkflowHandlerContext, WorkflowHandlerResult } from "../handler-registry.js";
import type { ProjectExecutionConfiguration } from "./execution-scope.js";
import type { PipelineJobPayload } from "./pipeline-job.js";
import type { StationDependencies } from "./station-context.js";

export const runVerifyStation = async (
  _payload: PipelineJobPayload,
  _context: WorkflowHandlerContext,
  _dependencies: StationDependencies,
  _configuration: ProjectExecutionConfiguration
): Promise<WorkflowHandlerResult> => {
  throw new Error("Not implemented yet.");
};
