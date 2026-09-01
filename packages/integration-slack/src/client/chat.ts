import { SlackRequestError, classifySlackFailure } from "../errors.js";

export interface SlackChatDependencies {
  readonly fetch: typeof globalThis.fetch;
  readonly botToken: () => Promise<string>;
  readonly baseUrl?: string;
}

export interface SlackPostMessageRequest {
  readonly channel: string;
  readonly threadTs: string;
  readonly text: string;
  readonly blocks?: readonly unknown[];
}

export interface SlackPostMessageResult {
  readonly channel: string;
  readonly ts: string;
}

interface SlackChatPostMessageResponseBody {
  readonly ok: boolean;
  readonly error?: string;
  readonly channel?: string;
  readonly ts?: string;
}

export interface SlackChatClient {
  readonly postMessage: (request: SlackPostMessageRequest) => Promise<SlackPostMessageResult>;
}

const DEFAULT_BASE_URL = "https://slack.com/api";
// A small bounded retry count for a retryable Slack failure. This package injects no timer
// (no `setTimeout`, no real clock in `src/`), so there is no actual delay between attempts here;
// production backoff *scheduling* between attempts is the caller's job — this client only bounds
// how many times a single request retries within one logical call.
const MAX_ATTEMPTS = 3;

const unreachableFailure = (): SlackRequestError =>
  new SlackRequestError("Slack chat.postMessage did not succeed.", "provider_unavailable", true);

/**
 * A thin wrapper around Slack's `chat.postMessage` Web API method (spec §4.3, §8.3). Slack
 * returns HTTP 200 with `{ ok: false, error }` for most failures, so the response body is always
 * classified via {@link classifySlackFailure} rather than trusting the HTTP status alone. A
 * retryable failure (`rate_limited`, `provider_unavailable`) retries up to {@link MAX_ATTEMPTS};
 * a non-retryable failure (`unauthenticated`, `invalid_request`, ...) throws on the first attempt.
 */
export const createSlackChatClient = (deps: SlackChatDependencies): SlackChatClient => {
  const baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;

  const postMessage = async (request: SlackPostMessageRequest): Promise<SlackPostMessageResult> => {
    const token = await deps.botToken();
    let lastFailure: SlackRequestError | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const response = await deps.fetch(`${baseUrl}/chat.postMessage`, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          channel: request.channel,
          thread_ts: request.threadTs,
          text: request.text,
          ...(request.blocks === undefined ? {} : { blocks: request.blocks })
        })
      });

      const body = (await response.json()) as SlackChatPostMessageResponseBody;
      if (body.ok) {
        return { channel: body.channel ?? request.channel, ts: body.ts ?? "" };
      }

      const classification = classifySlackFailure({ status: response.status, body });
      lastFailure = new SlackRequestError(
        "Slack chat.postMessage did not succeed.",
        classification.code,
        classification.retryable
      );
      if (!classification.retryable || attempt === MAX_ATTEMPTS) throw lastFailure;
    }

    // Unreachable: every iteration above either returns or throws by the final attempt.
    throw lastFailure ?? unreachableFailure();
  };

  return { postMessage };
};
