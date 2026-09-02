/**
 * Registers all six delivery pipeline stations with a `HandlerRegistry`.
 *
 * Each station is registered as `pipeline.<stage>` and is given the shared
 * `StationDependencies` and `ProjectExecutionConfiguration` at registration time.
 * The handler validates its payload with `PipelineJobPayloadSchema` and wires
 * `context.signal` through to the dependencies.
 */

import { HandlerRegistry } from "../handler-registry.js";
import { PipelineJobPayloadSchema, type PipelineJobPayload } from "./pipeline-job.js";
import type { StationDependencies } from "./station-context.js";
import type { ProjectExecutionConfiguration } from "./execution-scope.js";
import { runTriageStation } from "./triage-station.js";
import { runPlanStation } from "./plan-station.js";
import { runImplementStation } from "./implement-station.js";
import { runVerifyStation } from "./verify-station.js";
import { runReviewStation } from "./review-station.js";
import { runPublishStation } from "./publish-station.js";

export interface RegisterPipelineStationsDependencies {
  /** Dependencies shared by all stations — minus signal, which comes from the handler context. */
  readonly dependencies: Omit<StationDependencies, "signal">;
  readonly configuration: ProjectExecutionConfiguration;
}

const STATION_NAMES = [
  "pipeline.triage",
  "pipeline.plan",
  "pipeline.implement",
  "pipeline.verify",
  "pipeline.review",
  "pipeline.publish"
] as const;

export function registerPipelineStations(
  registry: HandlerRegistry,
  options: RegisterPipelineStationsDependencies
): void {
  const { dependencies, configuration } = options;

  const withSignal = (signal: AbortSignal): StationDependencies => ({
    ...dependencies,
    signal
  });

  registry.register(
    "pipeline.triage",
    PipelineJobPayloadSchema,
    (payload: PipelineJobPayload, context) =>
      runTriageStation(payload, context, withSignal(context.signal))
  );

  registry.register(
    "pipeline.plan",
    PipelineJobPayloadSchema,
    (payload: PipelineJobPayload, context) =>
      runPlanStation(payload, context, withSignal(context.signal), configuration)
  );

  registry.register(
    "pipeline.implement",
    PipelineJobPayloadSchema,
    (payload: PipelineJobPayload, context) =>
      runImplementStation(payload, context, withSignal(context.signal), configuration)
  );

  registry.register(
    "pipeline.verify",
    PipelineJobPayloadSchema,
    (payload: PipelineJobPayload, context) =>
      runVerifyStation(payload, context, withSignal(context.signal), configuration)
  );

  registry.register(
    "pipeline.review",
    PipelineJobPayloadSchema,
    (payload: PipelineJobPayload, context) =>
      runReviewStation(payload, context, withSignal(context.signal), configuration)
  );

  registry.register(
    "pipeline.publish",
    PipelineJobPayloadSchema,
    (payload: PipelineJobPayload, context) =>
      runPublishStation(payload, context, withSignal(context.signal), configuration)
  );
}

export { STATION_NAMES };
