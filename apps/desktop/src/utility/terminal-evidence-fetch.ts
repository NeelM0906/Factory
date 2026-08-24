import {
  DisposeEnvironmentRequestSchema,
  type DisposeEnvironmentRequest
} from "@autostack/contracts";

export const createTerminalEvidenceAuthorizingFetch = (options: {
  readonly hostOrigin: string;
  readonly authorize: (request: DisposeEnvironmentRequest) => Promise<void>;
  readonly fetch?: typeof globalThis.fetch;
}): typeof globalThis.fetch => {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input.toString() : input.url
    );
    if (
      url.origin === options.hostOrigin &&
      init?.method === "DELETE" &&
      /^\/v1\/environments\/[^/]+$/.test(url.pathname)
    ) {
      if (typeof init.body !== "string") {
        throw new TypeError("terminal evidence request body is unavailable");
      }
      const request = DisposeEnvironmentRequestSchema.parse(JSON.parse(init.body));
      await options.authorize(request);
    }
    return await fetchImplementation(input, init);
  };
};
