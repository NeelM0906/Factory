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
import { assertPostable } from "./message/postable.js";

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
  /**
   * Resolves an outbound request's opaque `bindingRef` to its binding. Throws when no *enabled*
   * binding exists; never returns undefined.
   *
   * Takes the `bindingRef` verbatim and imposes no structure on it. `ChannelBindingSchema` models
   * `bindingRef` as an opaque `StableRefSchema` *alongside* separate `slackWorkspaceId` and
   * `channelId` fields — so the reference is an identifier, not a composite key, and parsing
   * workspace/channel out of it would invent a cross-stream convention the contract never
   * declares. Whoever mints bindings (S4/composition) is free to use an opaque `chb_…` id like
   * every other identifier in this repo, and this adapter keeps working.
   *
   * The resolver owns the binding store, so it is the component that can answer this. The
   * workspace/channel pair it returns is then authoritative for the outbound call.
   */
  readonly resolveBindingByRef: (bindingRef: string) => Promise<SlackChannelBinding>;
  /** Already-resolved by the credential store; S5 never dereferences a CredentialRefId. */
  readonly botToken: () => Promise<string>;
  readonly signingSecret: () => Promise<string>;
  readonly idempotency?: IdempotencyRecordStore;
  readonly baseUrl?: string;
}

export type SlackIntegration = Pick<DeliveryIntegrationPort, "postSlackProgress"> &
  SlackApprovalIntegrationPort;

/**
 * Fail-closed binding resolution (spec §13.2, decision D10). A `resolveBindingByRef` that throws,
 * a disabled binding, a non-Slack binding, or one whose own `bindingRef` disagrees with the one
 * requested are all rejected before anything is sent to Slack — this must run, and must fail,
 * before the first `fetch` call.
 */
const resolveEnabledBinding = async (
  deps: SlackIntegrationDependencies,
  bindingRef: string
): Promise<SlackChannelBinding> => {
  let resolved: SlackChannelBinding;
  try {
    resolved = await deps.resolveBindingByRef(bindingRef);
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
  // The resolver must return the binding that was actually asked for. Without this a buggy or
  // hostile resolver could redirect an approved run's messages into a different channel, so the
  // returned binding is checked against the requested reference rather than trusted.
  if (binding.bindingRef !== bindingRef) {
    throw new SlackRequestError(
      "Resolved Slack binding does not match the requested bindingRef.",
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
    // The never-post list (spec 13.2) is enforced here, not only in composeSlackMessage. The
    // composer's typed inputs make logs/diffs/reasoning unrepresentable, but this is a PORT
    // method: any caller holding the port can hand it a schema-valid SlackProgressRequest built
    // by other means -- raw agent output included. This is the last exit the adapter owns, so
    // the gate belongs here too, and that makes 13.2 unconditional rather than conventional.
    assertPostable(validated.text);
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
    // Same reasoning as postSlackProgress: a port method must not trust that its caller went
    // through composeApprovalPrompt.
    assertPostable(validated.summary);
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
