import {
  ChannelBindingSchema,
  SlackApprovalPromptSchema,
  SlackProgressRequestSchema,
  type ChannelBinding,
  type DeliveryIntegrationPort,
  type SlackApprovalIntegrationPort,
  type SlackApprovalPrompt,
  type SlackProgressRequest
} from "@autostack/contracts";

import { createSlackChatClient, type SlackChatClient } from "./client/chat.js";
import { SlackRequestError } from "./errors.js";
import { buildApprovalPromptBlocks } from "./message/approval-prompt.js";

/** The Slack member of the `ChannelBinding` union (spec §13.2, decision D10). */
export type SlackChannelBinding = Extract<ChannelBinding, { provider: "slack" }>;

/**
 * Records which idempotency keys have already produced a Slack side effect. In-memory and
 * `Map`-backed by default (decision D4) — no persistence in this stream; durable storage belongs
 * to the pipeline (S4).
 */
export interface IdempotencyRecordStore {
  readonly has: (key: string) => Promise<boolean>;
  readonly record: (key: string) => Promise<void>;
}

export const createMemoryIdempotencyRecordStore = (): IdempotencyRecordStore => {
  const seen = new Set<string>();
  return {
    has: async (key: string) => seen.has(key),
    record: async (key: string) => {
      seen.add(key);
    }
  };
};

export interface SlackIntegrationDependencies {
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => string;
  /** Throws when no *enabled* binding exists. Never returns undefined. */
  readonly resolveBinding: (input: {
    readonly slackWorkspaceId: string;
    readonly channelId: string;
  }) => Promise<SlackChannelBinding>;
  /** Already-resolved by the credential store; S5 never dereferences a CredentialRefId. */
  readonly botToken: () => Promise<string>;
  readonly signingSecret: () => Promise<string>;
  readonly idempotency?: IdempotencyRecordStore;
  readonly baseUrl?: string;
}

export type SlackIntegration = Pick<DeliveryIntegrationPort, "postSlackProgress"> &
  SlackApprovalIntegrationPort;

const BINDING_REF_SEPARATOR = ":";

/**
 * This stream's `bindingRef` convention: `${slackWorkspaceId}:${channelId}` (`StableRefSchema`
 * permits the colon). `SlackProgressRequest`/`SlackApprovalPrompt` carry only the opaque
 * `bindingRef`, not the workspace/channel pair directly, so this is how `postSlackProgress` and
 * `postApprovalPrompt` recover the values `resolveBinding` needs — without ever dereferencing a
 * `CredentialRefId` themselves.
 */
const parseBindingRef = (bindingRef: string): { slackWorkspaceId: string; channelId: string } => {
  const separatorIndex = bindingRef.indexOf(BINDING_REF_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex === bindingRef.length - 1) {
    throw new SlackRequestError(
      "Slack bindingRef is not a recognized workspace:channel reference.",
      "invalid_request",
      false
    );
  }
  return {
    slackWorkspaceId: bindingRef.slice(0, separatorIndex),
    channelId: bindingRef.slice(separatorIndex + 1)
  };
};

/**
 * Fail-closed binding resolution (spec §13.2, decision D10). A `resolveBinding` that throws, a
 * disabled binding, or a binding whose workspace/channel disagree with what was asked for are all
 * rejected before anything is sent to Slack — this must run, and must fail, before the first
 * `fetch` call.
 */
const resolveEnabledBinding = async (
  deps: SlackIntegrationDependencies,
  bindingRef: string
): Promise<SlackChannelBinding> => {
  const { slackWorkspaceId, channelId } = parseBindingRef(bindingRef);

  let resolved: SlackChannelBinding;
  try {
    resolved = await deps.resolveBinding({ slackWorkspaceId, channelId });
  } catch (cause) {
    throw new SlackRequestError(
      "No enabled Slack channel binding could be resolved for this request.",
      "invalid_request",
      false,
      { cause }
    );
  }

  const binding = ChannelBindingSchema.parse(resolved);
  if (binding.provider !== "slack") {
    throw new SlackRequestError(
      "Resolved channel binding is not a Slack binding.",
      "invalid_request",
      false
    );
  }
  if (!binding.enabled) {
    throw new SlackRequestError("Slack channel binding is disabled.", "invalid_request", false);
  }
  if (binding.slackWorkspaceId !== slackWorkspaceId || binding.channelId !== channelId) {
    throw new SlackRequestError(
      "Resolved Slack binding does not match the requested workspace/channel.",
      "invalid_request",
      false
    );
  }
  return binding;
};

/**
 * Assembles the Slack half of `DeliveryIntegrationPort` plus `SlackApprovalIntegrationPort`
 * (decision D1). Every network call goes through the injected `fetch`; every credential arrives
 * only via the injected `botToken`/`signingSecret` suppliers, called per request so rotation
 * takes effect, and retained on nothing this function returns (spec §13.2, decision D10).
 */
export const createSlackIntegration = (deps: SlackIntegrationDependencies): SlackIntegration => {
  const idempotency = deps.idempotency ?? createMemoryIdempotencyRecordStore();
  const chatClient: SlackChatClient = createSlackChatClient({
    fetch: deps.fetch,
    botToken: deps.botToken,
    ...(deps.baseUrl === undefined ? {} : { baseUrl: deps.baseUrl })
  });

  const postSlackProgress = async (request: SlackProgressRequest): Promise<void> => {
    const validated = SlackProgressRequestSchema.parse(request);
    if (await idempotency.has(validated.idempotencyKey)) return;

    const binding = await resolveEnabledBinding(deps, validated.bindingRef);

    await chatClient.postMessage({
      channel: binding.channelId,
      threadTs: validated.threadTs,
      text: validated.text
    });

    await idempotency.record(validated.idempotencyKey);
  };

  const postApprovalPrompt = async (prompt: SlackApprovalPrompt): Promise<void> => {
    const validated = SlackApprovalPromptSchema.parse(prompt);
    if (await idempotency.has(validated.idempotencyKey)) return;

    const binding = await resolveEnabledBinding(deps, validated.bindingRef);

    await chatClient.postMessage({
      channel: binding.channelId,
      threadTs: validated.threadTs,
      text: validated.summary,
      blocks: buildApprovalPromptBlocks(validated)
    });

    await idempotency.record(validated.idempotencyKey);
  };

  return { postSlackProgress, postApprovalPrompt };
};
