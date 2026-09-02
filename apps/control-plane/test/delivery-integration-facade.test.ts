/**
 * Two-provider DeliveryIntegrationPort facade tests (Task 4b).
 *
 * The facade is a pure delegation layer. These tests verify that each method is forwarded
 * to the correct provider and that errors propagate. We use `as never` for request/result
 * values because the test is about routing, not schema validation.
 */
import { describe, expect, it, vi } from "vitest";

import type { DeliveryIntegrationPort } from "@autostack/contracts";

import { createDeliveryIntegrationFacade } from "../src/delivery-integration-facade.js";

describe("createDeliveryIntegrationFacade", () => {
  const makeProviders = () => {
    const github: Pick<DeliveryIntegrationPort, "createDraftPullRequest"> = {
      createDraftPullRequest: vi.fn(async () => ({ number: 42 }) as never)
    };
    const slack: Pick<DeliveryIntegrationPort, "postSlackProgress"> = {
      postSlackProgress: vi.fn(async () => {})
    };
    return { github, slack };
  };

  it("delegates createDraftPullRequest to the GitHub provider", async () => {
    const { github, slack } = makeProviders();
    const facade = createDeliveryIntegrationFacade({ github, slack });

    const request = { test: "pr-request" } as never;
    const result = await facade.createDraftPullRequest(request);

    expect(github.createDraftPullRequest).toHaveBeenCalledWith(request);
    expect((result as { number: number }).number).toBe(42);
    expect(slack.postSlackProgress).not.toHaveBeenCalled();
  });

  it("delegates postSlackProgress to the Slack provider", async () => {
    const { github, slack } = makeProviders();
    const facade = createDeliveryIntegrationFacade({ github, slack });

    const request = { test: "slack-progress" } as never;
    await facade.postSlackProgress(request);

    expect(slack.postSlackProgress).toHaveBeenCalledWith(request);
    expect(github.createDraftPullRequest).not.toHaveBeenCalled();
  });

  it("propagates errors from the GitHub provider", async () => {
    const { github, slack } = makeProviders();
    (github.createDraftPullRequest as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("GitHub rate limited")
    );
    const facade = createDeliveryIntegrationFacade({ github, slack });

    await expect(facade.createDraftPullRequest({} as never)).rejects.toThrow(
      "GitHub rate limited"
    );
  });

  it("propagates errors from the Slack provider", async () => {
    const { github, slack } = makeProviders();
    (slack.postSlackProgress as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Slack channel not found")
    );
    const facade = createDeliveryIntegrationFacade({ github, slack });

    await expect(facade.postSlackProgress({} as never)).rejects.toThrow(
      "Slack channel not found"
    );
  });
});
