import {
  ModelInferenceRequestSchema,
  ModelInferenceResultSchema,
  ModelRoutingError,
  admitModelInferenceResult,
  type ModelInferencePort,
  type ModelInferenceRequest,
  type ModelInferenceResult
} from "@autostack/contracts";

import type { FakeModelRoutingFailureTemplate } from "./fake-model-router.js";

/**
 * What a scripted completion says. Identity comes from the request being answered and the timestamp
 * from the injected clock, so a script cannot return a result for a route it was not asked about.
 */
export type FakeModelInferenceResultTemplate = Omit<
  ModelInferenceResult,
  "schemaVersion" | "idempotencyKey" | "routeRef" | "completedAt"
>;

export type FakeModelInferenceOutcome =
  | { readonly kind: "completed"; readonly result: FakeModelInferenceResultTemplate }
  | { readonly kind: "failure"; readonly failure: FakeModelRoutingFailureTemplate };

export interface FakeModelInferenceOptions {
  readonly outcomes: readonly FakeModelInferenceOutcome[];
  readonly now: () => string;
}

export interface FakeModelInference extends ModelInferencePort {
  readonly requests: readonly ModelInferenceRequest[];
}

export const createFakeModelInference = (
  options: FakeModelInferenceOptions
): FakeModelInference => {
  const requests: ModelInferenceRequest[] = [];
  let cursor = 0;

  const run = async (request: ModelInferenceRequest): Promise<ModelInferenceResult> => {
    const admittedRequest = ModelInferenceRequestSchema.parse(request);
    requests.push(admittedRequest);

    const outcome = options.outcomes[cursor];
    if (outcome === undefined) {
      throw new TypeError(
        "The fake model inference has no scripted outcome left for this request."
      );
    }
    cursor += 1;

    if (outcome.kind === "failure") {
      throw new ModelRoutingError({ ...outcome.failure, schemaVersion: 1 });
    }

    const result = ModelInferenceResultSchema.parse({
      ...outcome.result,
      schemaVersion: 1,
      idempotencyKey: admittedRequest.idempotencyKey,
      routeRef: admittedRequest.selection.routeRef,
      completedAt: options.now()
    });
    return admitModelInferenceResult(admittedRequest, result);
  };

  return {
    get requests() {
      return [...requests];
    },
    run
  };
};
