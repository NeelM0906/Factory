/**
 * Two-provider DeliveryIntegrationPort facade (Task 4b).
 *
 * Composes the GitHub half (`createDraftPullRequest`) and the Slack half (`postSlackProgress`)
 * into a single `DeliveryIntegrationPort` that the pipeline stations can consume without knowing
 * which provider backs which operation.
 *
 * Decision D1 places this composition in the control-plane (the composition root), not in either
 * provider package. The control-plane owns the lifetime of both provider integrations and is the
 * only layer that has both as dependencies.
 */

import type {
  DeliveryIntegrationPort,
  DraftPullRequestRequest,
  DraftPullRequestResult,
  SlackProgressRequest
} from "@autostack/contracts";

export interface DeliveryIntegrationFacadeDependencies {
  readonly github: Pick<DeliveryIntegrationPort, "createDraftPullRequest">;
  readonly slack: Pick<DeliveryIntegrationPort, "postSlackProgress">;
}

export function createDeliveryIntegrationFacade(
  dependencies: DeliveryIntegrationFacadeDependencies
): DeliveryIntegrationPort {
  return {
    createDraftPullRequest(request: DraftPullRequestRequest): Promise<DraftPullRequestResult> {
      return dependencies.github.createDraftPullRequest(request);
    },
    postSlackProgress(request: SlackProgressRequest): Promise<void> {
      return dependencies.slack.postSlackProgress(request);
    }
  };
}
