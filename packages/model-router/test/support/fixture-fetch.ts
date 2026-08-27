/**
 * A `typeof globalThis.fetch` double for gate-suite tests (spec §14.1's "no live network"). Matches
 * requests on method + URL against a table of scripted routes and returns a `Response` built from a
 * fixture. The call log records `{ url, method, headerNames }` — header **names** only, never
 * values, so a test cannot assert a credential into existence by reading it back off the log
 * (finding 3). An unmatched request rejects with `UnmatchedFixtureFetchRequestError` so an
 * accidental live call fails loudly instead of quietly escaping the gate suite.
 *
 * Reused by later tasks (catalog discovery, the catalog cache, the language-model factory, and the
 * per-transport integration matrix), so each route scripts a *sequence* of responses consumed in
 * call order — the last response repeats once the sequence is exhausted — which is what lets a
 * later test express "first call succeeds, second call fails" against the same URL.
 */

export interface FixtureFetchCall {
  readonly url: string;
  readonly method: string;
  readonly headerNames: readonly string[];
}

export type FixtureFetchResponseSpec =
  | {
      readonly kind: "response";
      readonly status?: number;
      readonly headers?: Readonly<Record<string, string>>;
      /** JSON-serialized as the response body. Ignored when `rawBody` is set. */
      readonly body?: unknown;
      /** Raw text body, for exercising a malformed / non-JSON payload. Overrides `body`. */
      readonly rawBody?: string;
    }
  | {
      readonly kind: "throws";
      /** The value `fetch()` rejects with — a network-level failure, never an HTTP response. */
      readonly error: unknown;
    };

export interface FixtureFetchRoute {
  readonly method: string;
  readonly url: string;
  readonly responses: readonly FixtureFetchResponseSpec[];
}

export interface FixtureFetch {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: readonly FixtureFetchCall[];
}

/** Raised when a request matches no scripted route — a live network call escaping the double. */
export class UnmatchedFixtureFetchRequestError extends Error {
  constructor(method: string, url: string) {
    super(
      `No fixture route matches ${method} ${url}. Live network calls are forbidden in this suite.`
    );
    this.name = "UnmatchedFixtureFetchRequestError";
  }
}

const requestUrl = (input: string | URL | Request): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const headerNamesOf = (init?: HeadersInit): readonly string[] =>
  Array.from(new Headers(init).keys());

export const createFixtureFetch = (routes: readonly FixtureFetchRoute[]): FixtureFetch => {
  const calls: FixtureFetchCall[] = [];
  const nextResponseIndex = new Map<string, number>();

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = requestUrl(input as string | URL | Request);
    calls.push({ url, method, headerNames: headerNamesOf(init?.headers) });

    const route = routes.find(
      (candidate) => candidate.method.toUpperCase() === method && candidate.url === url
    );
    if (route === undefined || route.responses.length === 0) {
      throw new UnmatchedFixtureFetchRequestError(method, url);
    }

    const key = `${method} ${url}`;
    const callIndex = nextResponseIndex.get(key) ?? 0;
    nextResponseIndex.set(key, callIndex + 1);
    const spec = route.responses[Math.min(callIndex, route.responses.length - 1)];
    if (spec === undefined) {
      throw new UnmatchedFixtureFetchRequestError(method, url);
    }

    if (spec.kind === "throws") {
      throw spec.error;
    }

    const status = spec.status ?? 200;
    const responseHeaders = new Headers(spec.headers ?? {});
    const responseBody =
      spec.rawBody !== undefined
        ? spec.rawBody
        : spec.body === undefined
          ? undefined
          : JSON.stringify(spec.body);
    return new Response(responseBody, { status, headers: responseHeaders });
  };

  return { fetch: fetchImpl, calls };
};
