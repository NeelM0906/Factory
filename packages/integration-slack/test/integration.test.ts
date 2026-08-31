import {
  createId,
  type DeliveryIntegrationPort,
  type SlackApprovalIntegrationPort
} from "@autostack/contracts";
import { createFakeDeliveryIntegration } from "@autostack/domain/testing";
import { describe, expect, it, vi } from "vitest";

import { composeApprovalPrompt } from "../src/message/approval-prompt.js";
import { composeSlackMessage } from "../src/message/compose.js";
import {
  createSlackIntegration,
  type SlackChannelBinding,
  type SlackIntegrationDependencies
} from "../src/integration.js";
import * as SlackIntegrationModule from "../src/index.js";

const SLACK_WORKSPACE_ID = "T0AUTOSTACK1";
const CHANNEL_ID = "C0AUTOSTACKCH";
const BINDING_REF = `${SLACK_WORKSPACE_ID}:${CHANNEL_ID}`;
const RUN_URL = "https://runs.autostack.dev/run/abc123";
const NOW = "2026-08-31T00:00:00.000Z";
const BOT_TOKEN = "xoxb-fixture-not-a-real-token-0001";

const WORKSPACE_ID = createId("workspace", "00000000-0000-4000-8000-000000000001");
const PROJECT_ID = createId("project", "00000000-0000-4000-8000-000000000004");
const BOT_CREDENTIAL_REF_ID = createId("credentialRef", "00000000-0000-4000-8000-000000000002");
const SIGNING_CREDENTIAL_REF_ID = createId("credentialRef", "00000000-0000-4000-8000-000000000003");
const RUN_ID = createId("run", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
const APPROVAL_ID = createId("approval", "11111111-2222-4333-8444-555555555555");
const EVIDENCE_DIGEST = "a1b2c3d4".repeat(8);

const validBinding = (overrides: Partial<SlackChannelBinding> = {}): SlackChannelBinding => ({
  schemaVersion: 1,
  bindingRef: BINDING_REF,
  workspaceId: WORKSPACE_ID,
  provider: "slack",
  slackWorkspaceId: SLACK_WORKSPACE_ID,
  channelId: CHANNEL_ID,
  botCredentialRefId: BOT_CREDENTIAL_REF_ID,
  signingCredentialRefId: SIGNING_CREDENTIAL_REF_ID,
  enabled: true,
  ...overrides
});

interface FakeResponseSpec {
  readonly status: number;
  readonly body: { readonly ok: boolean; readonly error?: string; readonly ts?: string };
}

const createFakeFetch = (responses: readonly FakeResponseSpec[]) => {
  let index = 0;
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const spec = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (spec === undefined) throw new Error("createFakeFetch: no response configured");
    return new Response(JSON.stringify(spec.body), { status: spec.status });
  });
};

const buildDeps = (
  overrides: Partial<SlackIntegrationDependencies> = {}
): { deps: SlackIntegrationDependencies; botTokenFn: ReturnType<typeof vi.fn> } => {
  const botTokenFn = vi.fn(async () => BOT_TOKEN);
  const deps: SlackIntegrationDependencies = {
    fetch: createFakeFetch([{ status: 200, body: { ok: true, ts: "1700000300.000600" } }]),
    now: () => NOW,
    resolveBinding: vi.fn(async () => validBinding()),
    botToken: botTokenFn,
    signingSecret: vi.fn(async () => "fixture-signing-secret"),
    ...overrides
  };
  return { deps, botTokenFn };
};

describe("createSlackIntegration", () => {
  it("satisfies Pick<DeliveryIntegrationPort, 'postSlackProgress'> & SlackApprovalIntegrationPort", () => {
    const { deps } = buildDeps();
    const integration = createSlackIntegration(deps) satisfies Pick<
      DeliveryIntegrationPort,
      "postSlackProgress"
    > &
      SlackApprovalIntegrationPort;
    expect(typeof integration.postSlackProgress).toBe("function");
    expect(typeof integration.postApprovalPrompt).toBe("function");
  });

  describe("postSlackProgress", () => {
    it("validates the request schema before doing anything else", async () => {
      const { deps } = buildDeps();
      const resolveBindingFn = deps.resolveBinding as ReturnType<typeof vi.fn>;
      const integration = createSlackIntegration(deps);
      const malformed = { schemaVersion: 1 } as unknown as Parameters<
        typeof integration.postSlackProgress
      >[0];

      await expect(integration.postSlackProgress(malformed)).rejects.toThrow();
      expect(resolveBindingFn).not.toHaveBeenCalled();
      expect(deps.fetch).not.toHaveBeenCalled();
    });

    it("calls chat.postMessage with thread_ts set to the bound thread", async () => {
      const { deps } = buildDeps();
      const integration = createSlackIntegration(deps);
      const request = await composeSlackMessage(
        {
          kind: "stage_progress",
          stage: "verify",
          status: "started",
          headline: "Running the verification suite",
          runUrl: RUN_URL,
          evidenceDigest: EVIDENCE_DIGEST
        },
        { bindingRef: BINDING_REF, threadTs: "1700000300.000500" }
      );

      await integration.postSlackProgress(request);

      const fetchFn = deps.fetch as ReturnType<typeof vi.fn>;
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(init.body)) as { thread_ts?: string; channel?: string };
      expect(body.thread_ts).toBe("1700000300.000500");
      expect(body.channel).toBe(CHANNEL_ID);
    });

    it("is idempotent by key: a replay performs no second post", async () => {
      const { deps } = buildDeps();
      const integration = createSlackIntegration(deps);
      const request = await composeSlackMessage(
        {
          kind: "stage_progress",
          stage: "verify",
          status: "started",
          headline: "Running the verification suite",
          runUrl: RUN_URL,
          evidenceDigest: EVIDENCE_DIGEST
        },
        { bindingRef: BINDING_REF, threadTs: "1700000300.000500" }
      );

      await integration.postSlackProgress(request);
      await integration.postSlackProgress(request);

      expect(deps.fetch).toHaveBeenCalledTimes(1);
    });

    it("matches the fake delivery integration's replay behaviour (returns silently, no second post)", async () => {
      const { deps } = buildDeps();
      const integration = createSlackIntegration(deps);
      const fake = createFakeDeliveryIntegration({
        now: () => NOW,
        pullRequestNumber: () => 1,
        commentId: () => 1,
        providerEvidenceDigest: () => EVIDENCE_DIGEST
      });
      const request = await composeSlackMessage(
        {
          kind: "attention_request",
          headline: "Needs a decision",
          runUrl: RUN_URL,
          evidenceDigest: EVIDENCE_DIGEST
        },
        { bindingRef: BINDING_REF, threadTs: "1700000300.000500" }
      );

      await integration.postSlackProgress(request);
      await integration.postSlackProgress(request);
      await fake.postSlackProgress(request);
      await fake.postSlackProgress(request);

      expect(deps.fetch).toHaveBeenCalledTimes(1);
      expect(fake.slackProgress).toHaveLength(1);
    });

    it("retries a ratelimited failure and succeeds once the retry clears", async () => {
      const { deps } = buildDeps({
        fetch: createFakeFetch([
          { status: 200, body: { ok: false, error: "ratelimited" } },
          { status: 200, body: { ok: false, error: "ratelimited" } },
          { status: 200, body: { ok: true, ts: "1700000300.000600" } }
        ])
      });
      const integration = createSlackIntegration(deps);
      const request = await composeSlackMessage(
        {
          kind: "stage_progress",
          stage: "verify",
          status: "started",
          headline: "Running the verification suite",
          runUrl: RUN_URL,
          evidenceDigest: EVIDENCE_DIGEST
        },
        { bindingRef: BINDING_REF, threadTs: "1700000300.000500" }
      );

      await expect(integration.postSlackProgress(request)).resolves.toBeUndefined();
      expect(deps.fetch).toHaveBeenCalledTimes(3);
    });

    it("throws after exhausting retries on a persistent ratelimited failure", async () => {
      const { deps } = buildDeps({
        fetch: createFakeFetch([{ status: 200, body: { ok: false, error: "ratelimited" } }])
      });
      const integration = createSlackIntegration(deps);
      const request = await composeSlackMessage(
        {
          kind: "stage_progress",
          stage: "verify",
          status: "started",
          headline: "Running the verification suite",
          runUrl: RUN_URL,
          evidenceDigest: EVIDENCE_DIGEST
        },
        { bindingRef: BINDING_REF, threadTs: "1700000300.000500" }
      );

      await expect(integration.postSlackProgress(request)).rejects.toMatchObject({
        code: "rate_limited"
      });
      expect(deps.fetch).toHaveBeenCalledTimes(3);
    });

    it("does not retry an invalid_auth failure", async () => {
      const { deps } = buildDeps({
        fetch: createFakeFetch([{ status: 200, body: { ok: false, error: "invalid_auth" } }])
      });
      const integration = createSlackIntegration(deps);
      const request = await composeSlackMessage(
        {
          kind: "stage_progress",
          stage: "verify",
          status: "started",
          headline: "Running the verification suite",
          runUrl: RUN_URL,
          evidenceDigest: EVIDENCE_DIGEST
        },
        { bindingRef: BINDING_REF, threadTs: "1700000300.000500" }
      );

      await expect(integration.postSlackProgress(request)).rejects.toMatchObject({
        code: "unauthenticated"
      });
      expect(deps.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("postApprovalPrompt", () => {
    it("posts the prompt into the bound thread", async () => {
      const { deps } = buildDeps();
      const integration = createSlackIntegration(deps);
      const prompt = await composeApprovalPrompt({
        bindingRef: BINDING_REF,
        threadTs: "1700000300.000500",
        runId: RUN_ID,
        approvalId: APPROVAL_ID,
        kind: "publish",
        summary: "Ready to publish the draft pull request. Approve?",
        evidenceDigest: EVIDENCE_DIGEST,
        runUrl: RUN_URL
      });

      await integration.postApprovalPrompt(prompt);

      const fetchFn = deps.fetch as ReturnType<typeof vi.fn>;
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(init.body)) as {
        thread_ts?: string;
        channel?: string;
        blocks?: unknown;
      };
      expect(body.thread_ts).toBe("1700000300.000500");
      expect(body.channel).toBe(CHANNEL_ID);
      expect(body.blocks).toBeDefined();
    });

    it("is idempotent by key: a replay performs no second post", async () => {
      const { deps } = buildDeps();
      const integration = createSlackIntegration(deps);
      const prompt = await composeApprovalPrompt({
        bindingRef: BINDING_REF,
        threadTs: "1700000300.000500",
        runId: RUN_ID,
        approvalId: APPROVAL_ID,
        kind: "publish",
        summary: "Ready to publish the draft pull request. Approve?",
        evidenceDigest: EVIDENCE_DIGEST,
        runUrl: RUN_URL
      });

      await integration.postApprovalPrompt(prompt);
      await integration.postApprovalPrompt(prompt);

      expect(deps.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("fail-closed binding resolution", () => {
    it("fails with zero fetch calls when resolveBinding throws", async () => {
      const { deps } = buildDeps({
        resolveBinding: vi.fn(async () => {
          throw new Error("no binding for this workspace/channel");
        })
      });
      const integration = createSlackIntegration(deps);
      const request = await composeSlackMessage(
        {
          kind: "attention_request",
          headline: "Needs a decision",
          runUrl: RUN_URL,
          evidenceDigest: EVIDENCE_DIGEST
        },
        { bindingRef: BINDING_REF, threadTs: "1700000300.000500" }
      );

      await expect(integration.postSlackProgress(request)).rejects.toThrow();
      expect(deps.fetch).not.toHaveBeenCalled();
    });

    it("fails with zero fetch calls when the resolved binding is disabled", async () => {
      const { deps } = buildDeps({
        resolveBinding: vi.fn(async () => validBinding({ enabled: false }))
      });
      const integration = createSlackIntegration(deps);
      const request = await composeSlackMessage(
        {
          kind: "attention_request",
          headline: "Needs a decision",
          runUrl: RUN_URL,
          evidenceDigest: EVIDENCE_DIGEST
        },
        { bindingRef: BINDING_REF, threadTs: "1700000300.000500" }
      );

      await expect(integration.postSlackProgress(request)).rejects.toThrow();
      expect(deps.fetch).not.toHaveBeenCalled();
    });

    it("rejects a resolved binding whose workspace/channel disagree with the request", async () => {
      const { deps } = buildDeps({
        resolveBinding: vi.fn(async () =>
          validBinding({ slackWorkspaceId: "T_SOMEONE_ELSE", channelId: "C_SOMEONE_ELSE" })
        )
      });
      const integration = createSlackIntegration(deps);
      const request = await composeSlackMessage(
        {
          kind: "attention_request",
          headline: "Needs a decision",
          runUrl: RUN_URL,
          evidenceDigest: EVIDENCE_DIGEST
        },
        { bindingRef: BINDING_REF, threadTs: "1700000300.000500" }
      );

      await expect(integration.postSlackProgress(request)).rejects.toThrow();
      expect(deps.fetch).not.toHaveBeenCalled();
    });

    it("rejects a malformed bindingRef with zero fetch calls", async () => {
      const { deps } = buildDeps();
      const integration = createSlackIntegration(deps);
      const request = await composeSlackMessage(
        {
          kind: "attention_request",
          headline: "Needs a decision",
          runUrl: RUN_URL,
          evidenceDigest: EVIDENCE_DIGEST
        },
        { bindingRef: "not-a-workspace-channel-pair", threadTs: "1700000300.000500" }
      );

      await expect(integration.postSlackProgress(request)).rejects.toThrow();
      expect(deps.fetch).not.toHaveBeenCalled();
    });

    it("rejects a resolved binding that is not a Slack binding, with zero fetch calls", async () => {
      const githubBinding = {
        schemaVersion: 1,
        bindingRef: BINDING_REF,
        workspaceId: WORKSPACE_ID,
        projectId: PROJECT_ID,
        provider: "github",
        installationId: "install-1",
        repositoryId: "repo-1",
        repositoryFullName: "octocat/hello-world",
        credentialRefId: BOT_CREDENTIAL_REF_ID,
        enabled: true
      };
      const { deps } = buildDeps({
        resolveBinding: vi.fn(async () => githubBinding as unknown as SlackChannelBinding)
      });
      const integration = createSlackIntegration(deps);
      const request = await composeSlackMessage(
        {
          kind: "attention_request",
          headline: "Needs a decision",
          runUrl: RUN_URL,
          evidenceDigest: EVIDENCE_DIGEST
        },
        { bindingRef: BINDING_REF, threadTs: "1700000300.000500" }
      );

      await expect(integration.postSlackProgress(request)).rejects.toThrow();
      expect(deps.fetch).not.toHaveBeenCalled();
    });
  });

  describe("credential handling", () => {
    it("calls the botToken supplier once per request, not once globally", async () => {
      const { deps, botTokenFn } = buildDeps({
        fetch: createFakeFetch([
          { status: 200, body: { ok: true, ts: "1" } },
          { status: 200, body: { ok: true, ts: "2" } }
        ])
      });
      const integration = createSlackIntegration(deps);
      const first = await composeSlackMessage(
        {
          kind: "attention_request",
          headline: "First attention request",
          runUrl: RUN_URL,
          evidenceDigest: EVIDENCE_DIGEST
        },
        { bindingRef: BINDING_REF, threadTs: "1700000300.000500" }
      );
      const second = await composeSlackMessage(
        {
          kind: "attention_request",
          headline: "A different attention request",
          runUrl: RUN_URL,
          evidenceDigest: EVIDENCE_DIGEST
        },
        { bindingRef: BINDING_REF, threadTs: "1700000300.000500" }
      );

      await integration.postSlackProgress(first);
      await integration.postSlackProgress(second);

      expect(botTokenFn).toHaveBeenCalledTimes(2);
    });

    it("retains no token on the returned integration object", () => {
      const { deps } = buildDeps();
      const integration = createSlackIntegration(deps);
      expect(JSON.stringify(integration)).toBe("{}");
    });

    it("never lets the bot token appear in a thrown error", async () => {
      const { deps } = buildDeps({
        fetch: createFakeFetch([{ status: 200, body: { ok: false, error: "invalid_auth" } }])
      });
      const integration = createSlackIntegration(deps);
      const request = await composeSlackMessage(
        {
          kind: "attention_request",
          headline: "Needs a decision",
          runUrl: RUN_URL,
          evidenceDigest: EVIDENCE_DIGEST
        },
        { bindingRef: BINDING_REF, threadTs: "1700000300.000500" }
      );

      try {
        await integration.postSlackProgress(request);
        throw new Error("expected postSlackProgress to throw");
      } catch (error) {
        const serialized = JSON.stringify(error) + String((error as Error).message);
        expect(serialized).not.toContain(BOT_TOKEN);
      }
    });
  });
});

describe("index.ts export surface", () => {
  it("exports the Slack integration factory and its supporting composers", () => {
    expect(typeof SlackIntegrationModule.createSlackIntegration).toBe("function");
    expect(typeof SlackIntegrationModule.createMemoryIdempotencyRecordStore).toBe("function");
    expect(typeof SlackIntegrationModule.composeSlackMessage).toBe("function");
    expect(typeof SlackIntegrationModule.composeApprovalPrompt).toBe("function");
    expect(typeof SlackIntegrationModule.assertPostable).toBe("function");
    expect(typeof SlackIntegrationModule.buildApprovalPromptBlocks).toBe("function");
    expect(typeof SlackIntegrationModule.createSlackChatClient).toBe("function");
  });
});
