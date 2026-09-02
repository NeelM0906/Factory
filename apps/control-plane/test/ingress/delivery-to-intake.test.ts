/**
 * Ingress-to-intake converter tests (Task 2).
 *
 * Verifies that `convertDeliveryToIntake` maps `IngressDelivery` into
 * `IntakeWorkItemInput` with correct requester, source, and title mapping.
 * Includes the critical commenter != issue-author test vector.
 */
import { describe, expect, it } from "vitest";

import { IngressDeliverySchema, type IngressDelivery } from "@autostack/contracts";

import { convertDeliveryToIntake } from "../../src/ingress/delivery-to-intake.js";

const NOW = "2026-08-20T12:00:00.000Z";

// ---------------------------------------------------------------------------
// GitHub deliveries
// ---------------------------------------------------------------------------

describe("convertDeliveryToIntake: GitHub", () => {
  const baseGitHub: IngressDelivery = IngressDeliverySchema.parse({
    schemaVersion: 1,
    provider: "github",
    deliveryId: "gh-delivery-001",
    deduplicationKey: "gh-dedup-001",
    receivedAt: NOW,
    event: "issues.opened",
    repository: { id: "repo-123", fullName: "acme/widgets" },
    issue: {
      number: 42,
      title: "Fix checkout redirect",
      body: "When a user completes checkout they see a blank page.",
      authorId: "user-alice"
    }
  });

  it("maps issues.opened with author as requester", () => {
    const result = convertDeliveryToIntake(baseGitHub);

    expect(result.source).toEqual({
      kind: "github",
      repositoryFullName: "acme/widgets",
      issueNumber: 42,
      deliveryId: "gh-delivery-001"
    });
    expect(result.title).toBe("Fix checkout redirect");
    expect(result.description).toBe(
      "When a user completes checkout they see a blank page."
    );
    expect(result.requester).toEqual({ externalId: "user-alice" });
    expect(result.priority).toBe("normal");
    expect(result.labels).toEqual([]);
    expect(result.acceptanceContext).toEqual([]);
  });

  it("maps issues.edited with author as requester", () => {
    const delivery = IngressDeliverySchema.parse({
      ...baseGitHub,
      event: "issues.edited",
      deliveryId: "gh-delivery-002",
      deduplicationKey: "gh-dedup-002"
    });
    const result = convertDeliveryToIntake(delivery);
    expect(result.requester.externalId).toBe("user-alice");
  });

  /**
   * CRITICAL: For issue_comment.created, the authorId on the IngressDelivery
   * represents the COMMENTER, not the issue opener. The S5 GitHub adapter
   * already maps this correctly. This test vector verifies that the converter
   * passes through the authorId faithfully — if someone later breaks the S5
   * mapping, the converter must not paper over it.
   */
  it("maps issue_comment.created — authorId is the COMMENTER, not the issue opener", () => {
    const delivery = IngressDeliverySchema.parse({
      ...baseGitHub,
      event: "issue_comment.created",
      deliveryId: "gh-delivery-comment",
      deduplicationKey: "gh-dedup-comment",
      issue: {
        number: 42,
        title: "Fix checkout redirect",
        body: "When a user completes checkout they see a blank page.",
        authorId: "user-bob" // Bob commented, Alice opened the issue
      }
    });
    const result = convertDeliveryToIntake(delivery);

    // The requester must be Bob (the commenter), NOT Alice (the issue opener).
    expect(result.requester.externalId).toBe("user-bob");
    expect(result.source).toEqual({
      kind: "github",
      repositoryFullName: "acme/widgets",
      issueNumber: 42,
      deliveryId: "gh-delivery-comment"
    });
  });

  it("maps issues.labeled with author as requester", () => {
    const delivery = IngressDeliverySchema.parse({
      ...baseGitHub,
      event: "issues.labeled",
      deliveryId: "gh-delivery-003",
      deduplicationKey: "gh-dedup-003"
    });
    const result = convertDeliveryToIntake(delivery);
    expect(result.requester.externalId).toBe("user-alice");
  });
});

// ---------------------------------------------------------------------------
// Slack deliveries
// ---------------------------------------------------------------------------

describe("convertDeliveryToIntake: Slack", () => {
  const baseSlack: IngressDelivery = IngressDeliverySchema.parse({
    schemaVersion: 1,
    provider: "slack",
    deliveryId: "slack-delivery-001",
    deduplicationKey: "slack-dedup-001",
    receivedAt: NOW,
    event: "app_mention",
    slackWorkspaceId: "T01234567",
    channelId: "C98765432",
    threadTs: "1693576800.000001",
    messageTs: "1693576801.000002",
    userId: "U11111111",
    text: "Hey can you fix the login flow?"
  });

  it("maps app_mention with userId as requester", () => {
    const result = convertDeliveryToIntake(baseSlack);

    expect(result.source).toEqual({
      kind: "slack",
      slackWorkspaceId: "T01234567",
      channelId: "C98765432",
      threadTs: "1693576800.000001",
      deliveryId: "slack-delivery-001"
    });
    expect(result.title).toBe("Hey can you fix the login flow?");
    expect(result.requester).toEqual({ externalId: "U11111111" });
    expect(result.priority).toBe("normal");
    expect(result.labels).toEqual([]);
    expect(result.acceptanceContext).toEqual([]);
  });

  it("truncates Slack text to 240 chars for the title", () => {
    const longText = "A".repeat(300);
    const delivery = IngressDeliverySchema.parse({
      ...baseSlack,
      text: longText,
      deliveryId: "slack-delivery-long",
      deduplicationKey: "slack-dedup-long"
    });
    const result = convertDeliveryToIntake(delivery);
    expect(result.title.length).toBeLessThanOrEqual(240);
    expect(result.description).toBe(longText);
  });
});
