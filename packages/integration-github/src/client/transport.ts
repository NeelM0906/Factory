import type { z } from "zod";

import { GitHubRequestError, classifyGitHubFailure } from "../errors.js";

const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_MAXIMUM_ATTEMPTS = 3;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
const BASE_DELAY_MS = 500;
const MAXIMUM_DELAY_MS = 30_000;
// A server-provided retry time (Retry-After, x-ratelimit-reset) is honoured even past
// MAXIMUM_DELAY_MS -- backoff must never be shorter than what the server asked for. This
// ceiling exists only to catch a nonsensical computed delay (e.g. a misconfigured or
// unreachable clock skewing an x-ratelimit-reset computation by orders of magnitude) well
// above any realistic GitHub-supplied wait, so a bad input degrades to a bounded wait
// instead of an effective hang.
const ABSOLUTE_DELAY_CEILING_MS = 60 * 60 * 1000;

// Injected clock/random/sleep so nothing here calls Date.now(), Math.random(), or a real
// timer directly. Callers (e.g. the composition root) supply the real implementations.
const DEFAULT_SLEEP = async (): Promise<void> => undefined;
const DEFAULT_RANDOM = (): number => 1;

/**
 * `x-ratelimit-reset` is an absolute epoch deadline, so turning it into a delay requires a
 * real clock. Without an injected `now` there is no honest way to compute that difference —
 * substituting a zero clock would subtract nothing from an epoch timestamp and produce a
 * delay of roughly the current Unix time in milliseconds (decades). So when no clock is
 * supplied the reset header is dropped before classification: the relative `Retry-After`
 * header and ordinary exponential backoff still apply, and only the header that genuinely
 * needs a clock is ignored. Fail toward a short, honest wait rather than a fabricated one.
 */
const classifyWithAvailableClock = (
  status: number,
  headers: Headers,
  now: (() => number) | undefined
): ReturnType<typeof classifyGitHubFailure> => {
  if (now !== undefined) return classifyGitHubFailure(status, headers, now);
  const clockless = new Headers(headers);
  clockless.delete("x-ratelimit-reset");
  return classifyGitHubFailure(status, clockless, () => 0);
};

export interface GitHubTransportOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly baseUrl?: string;
  readonly userAgent: string;
  readonly authorization: () => Promise<string>;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly maximumAttempts?: number;
  readonly maximumResponseBytes?: number;
  readonly now?: () => number;
}

interface GitHubTransportRequestSpec<T> {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
  readonly schema: z.ZodType<T>;
  readonly signal?: AbortSignal;
}

export interface GitHubTransport {
  request<T>(spec: GitHubTransportRequestSpec<T>): Promise<T>;
}

// A leading-slash-only path with no "//" prefix and no backslashes can never be interpreted
// by WHATWG URL parsing as an absolute or protocol-relative reference to a foreign host.
const isSafeRequestPath = (path: string): boolean =>
  path.startsWith("/") && !path.startsWith("//") && !path.includes("\\");

const resolveRequestUrl = (baseUrl: string, path: string): URL => {
  if (!isSafeRequestPath(path)) {
    throw new GitHubRequestError(
      `Request path "${path}" must be a site-relative GitHub API path.`,
      0,
      "invalid_request",
      false
    );
  }
  // String concatenation, not URL(path, base): a "/"-leading path resolved via the two-arg
  // URL constructor replaces the base's entire pathname instead of appending, which silently
  // drops any base sub-path (e.g. a GitHub Enterprise "/api/v3" prefix).
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return new URL(`${normalizedBase}${path}`);
};

const computeDelayMs = (
  attempt: number,
  retryAfterMs: number | undefined,
  random: () => number
): number => {
  const exponential = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAXIMUM_DELAY_MS);
  const jittered = Math.round(exponential * random());
  const floored = retryAfterMs === undefined ? jittered : Math.max(jittered, retryAfterMs);
  return Math.min(floored, ABSOLUTE_DELAY_CEILING_MS);
};

const cancelBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already terminal.
  }
};

const readBoundedBody = async (
  response: Response,
  maximumBytes: number,
  sensitiveValues: readonly string[]
): Promise<string> => {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximumBytes) {
        throw new GitHubRequestError(
          "GitHub response exceeded the maximum allowed size.",
          response.status,
          "invalid_response",
          false,
          { sensitiveValues }
        );
      }
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The response is already terminal.
    }
    reader.releaseLock();
  }
};

const parseBoundedBody = <T>(
  text: string,
  schema: z.ZodType<T>,
  status: number,
  sensitiveValues: readonly string[]
): T => {
  let candidate: unknown;
  if (text === "") {
    candidate = undefined;
  } else {
    try {
      candidate = JSON.parse(text) as unknown;
    } catch (cause) {
      throw new GitHubRequestError(
        "GitHub response could not be parsed as JSON.",
        status,
        "invalid_response",
        false,
        { cause, sensitiveValues }
      );
    }
  }
  const result = schema.safeParse(candidate);
  if (!result.success) {
    throw new GitHubRequestError(
      "GitHub response did not match the expected schema.",
      status,
      "invalid_response",
      false,
      { cause: result.error, sensitiveValues }
    );
  }
  return result.data;
};

/**
 * A bounded, backoff-aware GitHub REST transport. `redirect: "manual"` is non-negotiable on
 * every call: fetch's default "follow" would replay the Authorization header to whatever host
 * a response's Location header names, which is a credential-exfiltration primitive.
 */
export const createGitHubTransport = (options: GitHubTransportOptions): GitHubTransport => {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const maximumAttempts = options.maximumAttempts ?? DEFAULT_MAXIMUM_ATTEMPTS;
  const maximumResponseBytes = options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES;
  const sleep = options.sleep ?? DEFAULT_SLEEP;
  const random = options.random ?? DEFAULT_RANDOM;
  const now = options.now;

  const request = async <T>(spec: GitHubTransportRequestSpec<T>): Promise<T> => {
    const targetUrl = resolveRequestUrl(baseUrl, spec.path);
    const usedAuthorizationValues: string[] = [];
    // Serialized once, outside the retry loop: re-stringifying per attempt would let a
    // caller-mutated body object produce a different payload on retry, which would break
    // the idempotency later tasks rely on.
    const serializedBody = spec.body === undefined ? undefined : JSON.stringify(spec.body);

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      const authorizationValue = await options.authorization();
      usedAuthorizationValues.push(authorizationValue);

      const headers = new Headers({
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": options.userAgent,
        Authorization: authorizationValue
      });
      const init: RequestInit = { method: spec.method, headers, redirect: "manual" };
      if (spec.signal !== undefined) init.signal = spec.signal;
      if (serializedBody !== undefined) {
        headers.set("Content-Type", "application/json");
        init.body = serializedBody;
      }

      let response: Response;
      try {
        response = await options.fetch(targetUrl, init);
      } catch (error) {
        if (spec.signal?.aborted === true) throw error;
        if (attempt >= maximumAttempts) {
          throw new GitHubRequestError(
            "GitHub request failed before a response was received.",
            0,
            "provider_unavailable",
            true,
            { cause: error, sensitiveValues: usedAuthorizationValues }
          );
        }
        await sleep(computeDelayMs(attempt, undefined, random), spec.signal);
        continue;
      }

      if (response.status >= 300 && response.status < 400) {
        await cancelBody(response);
        throw new GitHubRequestError(
          "GitHub responded with a redirect, which is never followed.",
          response.status,
          "invalid_response",
          false,
          { sensitiveValues: usedAuthorizationValues }
        );
      }

      if (response.status >= 200 && response.status < 300) {
        const text = await readBoundedBody(response, maximumResponseBytes, usedAuthorizationValues);
        return parseBoundedBody(text, spec.schema, response.status, usedAuthorizationValues);
      }

      const classification = classifyWithAvailableClock(response.status, response.headers, now);
      await cancelBody(response);

      if (classification.retryable && attempt < maximumAttempts) {
        const delay = computeDelayMs(attempt, classification.retryAfterMs, random);
        await sleep(delay, spec.signal);
        continue;
      }

      throw new GitHubRequestError(
        `GitHub request failed with status ${response.status}.`,
        response.status,
        classification.code,
        classification.retryable,
        { sensitiveValues: usedAuthorizationValues }
      );
    }

    // Unreachable in practice: the loop above always returns or throws.
    throw new GitHubRequestError(
      "GitHub request failed after exhausting retry attempts.",
      0,
      "provider_unavailable",
      true,
      { sensitiveValues: usedAuthorizationValues }
    );
  };

  return { request };
};
