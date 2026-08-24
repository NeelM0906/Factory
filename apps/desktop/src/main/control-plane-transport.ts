import {
  DesktopApiOperationMapSchema,
  DesktopApiResponseSchemaByOperation,
  type DesktopApiOperationMap
} from "@autostack/contracts";

export interface DesktopControlPlaneTransport {
  request<K extends keyof DesktopApiOperationMap>(
    input: DesktopApiOperationMap[K]["request"]
  ): Promise<DesktopApiOperationMap[K]["response"]>;
}

export interface DesktopLocalOperationDispatcher {
  request<K extends Exclude<keyof DesktopApiOperationMap, `factory.${string}`>>(
    input: DesktopApiOperationMap[K]["request"]
  ): Promise<DesktopApiOperationMap[K]["response"]>;
}

export interface DesktopControlPlaneTransportOptions {
  readonly origin: string;
  readonly getToken: () => string | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly localDispatcher?: DesktopLocalOperationDispatcher;
}

const verifyOrigin = (candidate: string): string => {
  const url = new URL(candidate);
  const port = Number(url.port);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new TypeError("Control-plane origin must use numeric loopback.");
  }
  return url.origin;
};

export const createDesktopControlPlaneTransport = (
  options: DesktopControlPlaneTransportOptions
): DesktopControlPlaneTransport => {
  const origin = verifyOrigin(options.origin);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const fetchJson = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const token = options.getToken();
    if (token === undefined || token.length === 0) throw new Error("Desktop runtime unavailable.");
    let response: Response;
    try {
      response = await fetchImplementation(`${origin}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...init.headers }
      });
    } catch {
      throw new Error("Desktop runtime unavailable.");
    }
    if (!response.ok) throw new Error("Desktop runtime request failed.");
    try {
      return await response.json();
    } catch {
      throw new Error("Desktop runtime returned an invalid response.");
    }
  };

  return Object.freeze({
    async request<K extends keyof DesktopApiOperationMap>(
      input: DesktopApiOperationMap[K]["request"]
    ): Promise<DesktopApiOperationMap[K]["response"]> {
      const request = DesktopApiOperationMapSchema.parse(input);
      let response: unknown;
      if (request.operation === "factory.health") {
        response = await fetchJson("/v1/health");
      } else if (request.operation === "factory.runs.list") {
        response = await fetchJson(
          request.cursor === undefined
            ? "/v1/runs"
            : `/v1/runs?cursor=${encodeURIComponent(String(request.cursor))}`
        );
      } else if (request.operation === "factory.runs.events") {
        response = await fetchJson(
          `/v1/runs/${encodeURIComponent(request.runId)}/events?after=${encodeURIComponent(String(request.after))}`
        );
      } else if (request.operation === "factory.runs.create") {
        response = await fetchJson("/v1/runs", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": request.idempotencyKey
          },
          body: JSON.stringify(request.request)
        });
      } else if (request.operation === "local.list") {
        response = await fetchJson("/v1/local/environments");
      } else if (request.operation === "local.artifact.read") {
        response = await fetchJson(
          `/v1/local/artifacts/${encodeURIComponent(request.artifactId)}/content?offset=${request.offset}&length=${request.length}`
        );
      } else if (request.operation === "local.cancel") {
        response = await fetchJson(
          `/v1/local/environments/${encodeURIComponent(request.environmentId)}/commands/${encodeURIComponent(request.commandId)}/cancel`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              environmentId: request.environmentId,
              commandId: request.commandId,
              commandAuthorizationId: request.commandAuthorizationId,
              idempotencyKey: request.idempotencyKey
            })
          }
        );
      } else if (request.operation === "local.dispose") {
        response = await fetchJson(
          `/v1/local/environments/${encodeURIComponent(request.environmentId)}`,
          {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              environmentId: request.environmentId,
              environmentAuthorizationId: request.environmentAuthorizationId,
              idempotencyKey: request.idempotencyKey
            })
          }
        );
      } else {
        if (options.localDispatcher === undefined) {
          throw new Error("Desktop local-operation dispatcher unavailable.");
        }
        response = await options.localDispatcher.request(request as never);
      }
      return DesktopApiResponseSchemaByOperation[request.operation].parse(
        response
      ) as DesktopApiOperationMap[K]["response"];
    }
  });
};
