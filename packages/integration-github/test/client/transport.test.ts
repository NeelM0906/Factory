import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createGitHubTransport } from "../../src/client/transport.js";

const USER_AGENT = "autostack-test/1.0";

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

const recordingFetch = (
  handler: (call: RecordedCall, callIndex: number) => Response | Promise<Response>
): { readonly fetch: typeof globalThis.fetch; readonly calls: RecordedCall[] } => {
  const calls: RecordedCall[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });

const requireCall = (calls: readonly RecordedCall[], index: number): RecordedCall => {
  const call = calls[index];
  if (call === undefined) throw new Error(`Expected a fetch call at index ${index}.`);
  return call;
};

const requireMockCall = <A extends readonly unknown[]>(
  calls: readonly (readonly unknown[])[],
  index: number
): A => {
  const call = calls[index];
  if (call === undefined) throw new Error(`Expected a mock call at index ${index}.`);
  return call as A;
};

const widgetSchema = z.object({ id: z.number() });

describe("createGitHubTransport", () => {
  describe("headers, path safety, and request assembly", () => {
    it("sends the required headers, the authorization result, and a JSON body", async () => {
      const { fetch, calls } = recordingFetch(() => jsonResponse({ id: 7 }));
      const authorization = vi.fn(async () => "Bearer test-token-value");
      const transport = createGitHubTransport({ fetch, userAgent: USER_AGENT, authorization });

      const result = await transport.request({
        method: "POST",
        path: "/repos/o/r/issues",
        body: { title: "hello" },
        schema: widgetSchema
      });

      expect(result).toEqual({ id: 7 });
      expect(calls).toHaveLength(1);
      const call = requireCall(calls, 0);
      const headers = new Headers(call.init.headers);
      expect(headers.get("accept")).toBe("application/vnd.github+json");
      expect(headers.get("x-github-api-version")).toBe("2022-11-28");
      expect(headers.get("user-agent")).toBe(USER_AGENT);
      expect(headers.get("authorization")).toBe("Bearer test-token-value");
      expect(headers.get("content-type")).toBe("application/json");
      expect(call.init.method).toBe("POST");
      expect(call.init.body).toBe(JSON.stringify({ title: "hello" }));
      expect(call.url).toBe("https://api.github.com/repos/o/r/issues");
    });

    it("joins the path against a supplied custom base URL", async () => {
      const { fetch, calls } = recordingFetch(() => jsonResponse({ id: 1 }));
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => "token abc",
        baseUrl: "https://ghe.example.com/api/v3"
      });

      await transport.request({ method: "GET", path: "/repos/o/r", schema: widgetSchema });

      expect(requireCall(calls, 0).url).toBe("https://ghe.example.com/api/v3/repos/o/r");
    });

    it("rejects an absolute-URL path before any fetch call", async () => {
      const { fetch, calls } = recordingFetch(() => jsonResponse({ id: 1 }));
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => "Bearer x"
      });

      await expect(
        transport.request({
          method: "GET",
          path: "https://evil.example/x",
          schema: widgetSchema
        })
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(calls).toHaveLength(0);
    });

    it("rejects a protocol-relative path before any fetch call", async () => {
      const { fetch, calls } = recordingFetch(() => jsonResponse({ id: 1 }));
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => "Bearer x"
      });

      await expect(
        transport.request({ method: "GET", path: "//evil.example", schema: widgetSchema })
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(calls).toHaveLength(0);
    });

    it("rejects a backslash-prefixed path that WHATWG URL parsing would treat as protocol-relative", async () => {
      const { fetch, calls } = recordingFetch(() => jsonResponse({ id: 1 }));
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => "Bearer x"
      });

      await expect(
        transport.request({ method: "GET", path: "/\\evil.example", schema: widgetSchema })
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(calls).toHaveLength(0);
    });

    it("rejects a path without a leading slash before any fetch call", async () => {
      const { fetch, calls } = recordingFetch(() => jsonResponse({ id: 1 }));
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => "Bearer x"
      });

      await expect(
        transport.request({ method: "GET", path: "repos/o/r", schema: widgetSchema })
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(calls).toHaveLength(0);
    });
  });

  describe("authorization refresh per attempt", () => {
    it("calls authorization() once per attempt, not cached, so a token refresh takes effect on retry", async () => {
      let issued = 0;
      const authorization = vi.fn(async () => {
        issued += 1;
        return `Bearer token-${issued}`;
      });
      const { fetch, calls } = recordingFetch((_call, index) =>
        index === 0 ? new Response("", { status: 500 }) : jsonResponse({ id: 1 })
      );
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization,
        sleep: async () => undefined,
        random: () => 0
      });

      await transport.request({ method: "GET", path: "/repos/o/r", schema: widgetSchema });

      expect(authorization).toHaveBeenCalledTimes(2);
      const headers0 = new Headers(requireCall(calls, 0).init.headers);
      const headers1 = new Headers(requireCall(calls, 1).init.headers);
      expect(headers0.get("authorization")).toBe("Bearer token-1");
      expect(headers1.get("authorization")).toBe("Bearer token-2");
    });
  });

  describe("retry backoff", () => {
    it("retries a 500 once and resolves on the following 200, sleeping once with a deterministic jittered delay", async () => {
      const { fetch } = recordingFetch((_call, index) =>
        index === 0 ? new Response("", { status: 500 }) : jsonResponse({ id: 1 })
      );
      const sleep = vi.fn(async () => undefined);
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => "Bearer x",
        sleep,
        random: () => 0.4
      });

      const result = await transport.request({
        method: "GET",
        path: "/repos/o/r",
        schema: widgetSchema
      });

      expect(result).toEqual({ id: 1 });
      expect(sleep).toHaveBeenCalledTimes(1);
      const [delayMs] = requireMockCall<[number, AbortSignal | undefined]>(sleep.mock.calls, 0);
      // attempt 1 exponential band is [0, 500) before jitter; random()=0.4 makes it deterministic.
      expect(delayMs).toBe(200);
    });

    it("sleeps at least 2000ms when a 429 carries Retry-After: 2", async () => {
      const { fetch } = recordingFetch((_call, index) =>
        index === 0
          ? new Response("", { status: 429, headers: { "retry-after": "2" } })
          : jsonResponse({ id: 1 })
      );
      const sleep = vi.fn(async () => undefined);
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => "Bearer x",
        sleep
      });

      await transport.request({ method: "GET", path: "/repos/o/r", schema: widgetSchema });

      expect(sleep).toHaveBeenCalledTimes(1);
      const [delayMs] = requireMockCall<[number, AbortSignal | undefined]>(sleep.mock.calls, 0);
      expect(delayMs).toBeGreaterThanOrEqual(2000);
    });

    it("uses the injected now() to size an x-ratelimit-reset-derived delay", async () => {
      const fixedNow = 1_700_000_000_000;
      const resetEpochSeconds = Math.floor(fixedNow / 1000) + 90;
      const { fetch } = recordingFetch((_call, index) =>
        index === 0
          ? new Response("", {
              status: 429,
              headers: {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(resetEpochSeconds)
              }
            })
          : jsonResponse({ id: 1 })
      );
      const sleep = vi.fn(async () => undefined);
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => "Bearer x",
        sleep,
        random: () => 0,
        now: () => fixedNow
      });

      await transport.request({ method: "GET", path: "/repos/o/r", schema: widgetSchema });

      const [delayMs] = requireMockCall<[number, AbortSignal | undefined]>(sleep.mock.calls, 0);
      expect(delayMs).toBe(90_000);
    });

    it("ignores an epoch reset deadline when no clock was injected, rather than fabricating one", async () => {
      // x-ratelimit-reset is an ABSOLUTE epoch deadline, so deriving a delay from it needs a
      // real clock. With no `now` injected there is no honest difference to compute — and
      // substituting a zero clock would subtract nothing from an epoch timestamp, yielding a
      // delay of roughly the current Unix time in milliseconds (decades). The transport must
      // therefore drop the reset header entirely and fall back to ordinary exponential
      // backoff, not merely clamp the nonsense value down to a ceiling.
      const farFutureResetEpochSeconds = 4_000_000_000; // year ~2096
      const { fetch } = recordingFetch((_call, index) =>
        index === 0
          ? new Response("", {
              status: 429,
              headers: {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(farFutureResetEpochSeconds)
              }
            })
          : jsonResponse({ id: 1 })
      );
      const sleep = vi.fn(async () => undefined);
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => "Bearer x",
        sleep,
        random: () => 1
      });

      await transport.request({ method: "GET", path: "/repos/o/r", schema: widgetSchema });

      const [delayMs] = requireMockCall<[number, AbortSignal | undefined]>(sleep.mock.calls, 0);
      expect(delayMs).toBe(500);
    });

    it("still honours the relative Retry-After header when no clock was injected", async () => {
      // Retry-After is relative seconds, so it needs no clock and must keep working even
      // though the clockless path drops x-ratelimit-reset.
      const { fetch } = recordingFetch((_call, index) =>
        index === 0
          ? new Response("", {
              status: 429,
              headers: { "x-ratelimit-remaining": "0", "retry-after": "7" }
            })
          : jsonResponse({ id: 1 })
      );
      const sleep = vi.fn(async () => undefined);
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => "Bearer x",
        sleep,
        random: () => 1
      });

      await transport.request({ method: "GET", path: "/repos/o/r", schema: widgetSchema });

      const [delayMs] = requireMockCall<[number, AbortSignal | undefined]>(sleep.mock.calls, 0);
      expect(delayMs).toBe(7_000);
    });

    it("stops at maximumAttempts and throws the final failure rather than swallowing it", async () => {
      const { fetch, calls } = recordingFetch(() => new Response("", { status: 500 }));
      const sleep = vi.fn(async () => undefined);
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => "Bearer x",
        sleep,
        maximumAttempts: 2
      });

      await expect(
        transport.request({ method: "GET", path: "/repos/o/r", schema: widgetSchema })
      ).rejects.toMatchObject({ code: "provider_unavailable", retryable: true });
      expect(calls).toHaveLength(2);
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it("throws immediately with no fetch call when maximumAttempts is 0", async () => {
      const { fetch, calls } = recordingFetch(() => jsonResponse({ id: 1 }));
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => "Bearer x",
        maximumAttempts: 0
      });

      await expect(
        transport.request({ method: "GET", path: "/repos/o/r", schema: widgetSchema })
      ).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });

    it("serializes the request body once and reuses it across retries, immune to later mutation", async () => {
      const { fetch, calls } = recordingFetch((_call, index) =>
        index === 0 ? new Response("", { status: 500 }) : jsonResponse({ id: 1 })
      );
      const mutableBody: { title: string } = { title: "original" };
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => "Bearer x",
        sleep: async () => {
          mutableBody.title = "mutated-after-first-attempt";
        },
        random: () => 0
      });

      await transport.request({
        method: "POST",
        path: "/repos/o/r/issues",
        body: mutableBody,
        schema: widgetSchema
      });

      expect(calls).toHaveLength(2);
      const first = requireCall(calls, 0);
      const second = requireCall(calls, 1);
      expect(first.init.body).toBe(JSON.stringify({ title: "original" }));
      expect(second.init.body).toBe(first.init.body);
    });
  });

  describe("network-level fetch failures", () => {
    it("retries once when fetch itself rejects, then resolves on the following success", async () => {
      let attempts = 0;
      const fetch = vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("network error");
        return jsonResponse({ id: 1 });
      }) as unknown as typeof globalThis.fetch;
      const sleep = vi.fn(async () => undefined);
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => "Bearer x",
        sleep
      });

      const result = await transport.request({
        method: "GET",
        path: "/repos/o/r",
        schema: widgetSchema
      });

      expect(result).toEqual({ id: 1 });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it("throws provider_unavailable after exhausting attempts on repeated fetch rejection", async () => {
      const fetch = vi.fn(async () => {
        throw new TypeError("network error");
      }) as unknown as typeof globalThis.fetch;
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => "Bearer x",
        sleep: async () => undefined,
        maximumAttempts: 2
      });

      await expect(
        transport.request({ method: "GET", path: "/repos/o/r", schema: widgetSchema })
      ).rejects.toMatchObject({ code: "provider_unavailable", retryable: true });
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("non-retryable failures", () => {
    it("never retries a 422 and throws invalid_request after exactly one fetch call", async () => {
      const { fetch, calls } = recordingFetch(() => new Response("", { status: 422 }));
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => "Bearer x",
        sleep: async () => undefined
      });

      await expect(
        transport.request({ method: "GET", path: "/repos/o/r", schema: widgetSchema })
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(calls).toHaveLength(1);
    });
  });

  describe("bounded response reading", () => {
    it("throws instead of buffering a response body larger than maximumResponseBytes", async () => {
      const chunk = new Uint8Array(100).fill(97);
      let reads = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          reads += 1;
          if (reads > 6) {
            controller.close();
            return;
          }
          controller.enqueue(chunk);
        }
      });
      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" }
      });
      const { fetch } = recordingFetch(() => response);
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => "Bearer x",
        maximumResponseBytes: 150
      });

      await expect(
        transport.request({ method: "GET", path: "/repos/o/r", schema: widgetSchema })
      ).rejects.toMatchObject({ code: "invalid_response" });
      // It must reject after the 2nd chunk (200 bytes > 150) without pulling all 6+ chunks.
      expect(reads).toBeLessThanOrEqual(3);
    });
  });

  describe("schema validation failures", () => {
    it("throws invalid_response on a schema mismatch without leaking a body excerpt", async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse({ unexpectedMarker: "should-not-appear-in-message" })
      );
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => "Bearer x"
      });

      const failure = await transport
        .request({ method: "GET", path: "/repos/o/r", schema: widgetSchema })
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: "invalid_response" });
      expect(String((failure as Error).message)).not.toContain("should-not-appear-in-message");
    });

    it("throws invalid_response when a 200 body is not valid JSON", async () => {
      const { fetch } = recordingFetch(
        () =>
          new Response("not-json-at-all", {
            status: 200,
            headers: { "content-type": "application/json" }
          })
      );
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => "Bearer x"
      });

      await expect(
        transport.request({ method: "GET", path: "/repos/o/r", schema: widgetSchema })
      ).rejects.toMatchObject({ code: "invalid_response" });
    });
  });

  describe("empty-body success responses", () => {
    it("resolves a DELETE 204 with an empty body when the schema accepts undefined", async () => {
      const { fetch, calls } = recordingFetch(() => new Response(null, { status: 204 }));
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => "Bearer x"
      });

      const result = await transport.request({
        method: "DELETE",
        path: "/repos/o/r/issues/1/labels/bug",
        schema: z.void()
      });

      expect(result).toBeUndefined();
      expect(requireCall(calls, 0).init.method).toBe("DELETE");
    });
  });

  describe("redirect handling", () => {
    it("passes redirect: manual on every call", async () => {
      const { fetch, calls } = recordingFetch((_call, index) =>
        index === 0 ? new Response("", { status: 500 }) : jsonResponse({ id: 1 })
      );
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => "Bearer x",
        sleep: async () => undefined
      });

      await transport.request({ method: "GET", path: "/repos/o/r", schema: widgetSchema });

      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.init.redirect).toBe("manual");
      }
    });

    it("throws on a 302 to a foreign host, performs no second fetch, and never exposes Location or the authorization value", async () => {
      const { fetch, calls } = recordingFetch(
        () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.example/steal?token=leak" }
          })
      );
      const authorization = async (): Promise<string> => "Bearer super-secret-auth-value";
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization,
        sleep: async () => undefined
      });

      const failure = await transport
        .request({ method: "GET", path: "/repos/o/r", schema: widgetSchema })
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: "invalid_response" });
      expect(calls).toHaveLength(1);
      const message = String((failure as Error).message);
      expect(message).not.toContain("evil.example");
      expect(message).not.toContain("super-secret-auth-value");
      expect(message).not.toContain("Bearer");
    });
  });

  describe("header hygiene", () => {
    const authorizationValue = "Bearer very-sensitive-auth-value-0123456789";

    const assertNoLeak = (error: unknown): void => {
      const err = error as Error;
      expect(err.message).not.toContain(authorizationValue);
      expect(err.message).not.toContain("Bearer");
      expect(err.stack ?? "").not.toContain(authorizationValue);
      expect(err.stack ?? "").not.toContain("Bearer");
      expect(JSON.stringify(err)).not.toContain(authorizationValue);
      expect(JSON.stringify(err)).not.toContain("Bearer");
    };

    it("never leaks the authorization value on a 401 failure", async () => {
      const { fetch } = recordingFetch(() => new Response("", { status: 401 }));
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => authorizationValue
      });

      const failure = await transport
        .request({ method: "GET", path: "/repos/o/r", schema: widgetSchema })
        .catch((error: unknown) => error);
      assertNoLeak(failure);
    });

    it("never leaks the authorization value on a 422 failure", async () => {
      const { fetch } = recordingFetch(() => new Response("", { status: 422 }));
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => authorizationValue
      });

      const failure = await transport
        .request({ method: "GET", path: "/repos/o/r", schema: widgetSchema })
        .catch((error: unknown) => error);
      assertNoLeak(failure);
    });

    it("never leaks the authorization value on a schema-validation failure", async () => {
      const { fetch } = recordingFetch(() => jsonResponse({ notWhatWeWant: true }));
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => authorizationValue
      });

      const failure = await transport
        .request({ method: "GET", path: "/repos/o/r", schema: widgetSchema })
        .catch((error: unknown) => error);
      assertNoLeak(failure);
    });

    it("never leaks the authorization value on an oversized-body failure", async () => {
      const chunk = new Uint8Array(200).fill(97);
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(chunk);
          controller.close();
        }
      });
      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" }
      });
      const { fetch } = recordingFetch(() => response);
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => authorizationValue,
        maximumResponseBytes: 50
      });

      const failure = await transport
        .request({ method: "GET", path: "/repos/o/r", schema: widgetSchema })
        .catch((error: unknown) => error);
      assertNoLeak(failure);
    });

    it("never leaks the authorization value on a redirect failure", async () => {
      const { fetch } = recordingFetch(
        () => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } })
      );
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => authorizationValue
      });

      const failure = await transport
        .request({ method: "GET", path: "/repos/o/r", schema: widgetSchema })
        .catch((error: unknown) => error);
      assertNoLeak(failure);
    });

    it("never leaks the authorization value on an invalid-path failure", async () => {
      const { fetch } = recordingFetch(() => jsonResponse({ id: 1 }));
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => authorizationValue
      });

      const failure = await transport
        .request({ method: "GET", path: "https://evil.example/x", schema: widgetSchema })
        .catch((error: unknown) => error);
      assertNoLeak(failure);
    });
  });

  describe("signal forwarding", () => {
    it("forwards the AbortSignal to fetch", async () => {
      const controller = new AbortController();
      const { fetch, calls } = recordingFetch(() => jsonResponse({ id: 1 }));
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => "Bearer x"
      });

      await transport.request({
        method: "GET",
        path: "/repos/o/r",
        schema: widgetSchema,
        signal: controller.signal
      });

      expect(requireCall(calls, 0).init.signal).toBe(controller.signal);
    });

    it("forwards the AbortSignal to sleep and stops retrying once sleep rejects for it", async () => {
      const controller = new AbortController();
      const { fetch, calls } = recordingFetch(() => new Response("", { status: 500 }));
      const sleep = vi.fn(async (_ms: number, signal?: AbortSignal) => {
        if (signal?.aborted === true) throw new DOMException("Aborted", "AbortError");
      });
      const transport = createGitHubTransport({
        fetch,
        userAgent: USER_AGENT,
        authorization: async () => "Bearer x",
        sleep
      });
      controller.abort();

      await expect(
        transport.request({
          method: "GET",
          path: "/repos/o/r",
          schema: widgetSchema,
          signal: controller.signal
        })
      ).rejects.toThrow();

      expect(calls).toHaveLength(1);
      expect(sleep).toHaveBeenCalledTimes(1);
      const [, sleepSignal] = requireMockCall<[number, AbortSignal | undefined]>(
        sleep.mock.calls,
        0
      );
      expect(sleepSignal).toBe(controller.signal);
    });
  });
});
