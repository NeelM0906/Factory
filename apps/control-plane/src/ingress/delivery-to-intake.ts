/**
 * Ingress-to-intake converter (Task 2).
 *
 * Maps a provider-agnostic `IngressDelivery` into an `IntakeWorkItemInput` that the domain
 * layer can consume to create a work item and its initial run.
 *
 * Requester mapping:
 * - **GitHub**: `delivery.issue.authorId`. For `issue_comment.created`, the S5 adapter already
 *   sets `authorId` to the COMMENTER (not the issue opener), so this converter simply passes
 *   through the value it receives.
 * - **Slack**: `delivery.userId`, the user who sent the message.
 */

import type { IngressDelivery } from "@autostack/contracts";
import type { IntakeWorkItemInput } from "@autostack/domain";

const TITLE_MAX_LENGTH = 240;

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

export function convertDeliveryToIntake(delivery: IngressDelivery): IntakeWorkItemInput {
  switch (delivery.provider) {
    case "github":
      return {
        source: {
          kind: "github",
          repositoryFullName: delivery.repository.fullName,
          issueNumber: delivery.issue.number,
          deliveryId: delivery.deliveryId
        },
        title: delivery.issue.title,
        description: delivery.issue.body,
        requester: { externalId: delivery.issue.authorId },
        priority: "normal",
        labels: [],
        acceptanceContext: []
      };
    case "slack":
      return {
        source: {
          kind: "slack",
          slackWorkspaceId: delivery.slackWorkspaceId,
          channelId: delivery.channelId,
          threadTs: delivery.threadTs,
          deliveryId: delivery.deliveryId
        },
        title: truncate(delivery.text, TITLE_MAX_LENGTH),
        description: delivery.text,
        requester: { externalId: delivery.userId },
        priority: "normal",
        labels: [],
        acceptanceContext: []
      };
    default: {
      const _exhaustive: never = delivery;
      throw new Error(`Unsupported provider: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
