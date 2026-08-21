import {
  HealthResponseSchema,
  ListRunsResponseSchema,
  type HealthResponse,
  type ListRunsResponse
} from "@autostack/contracts";

export class CliAuthenticationError extends Error {
  constructor() {
    super("Authentication failed.");
    this.name = "CliAuthenticationError";
  }
}

export class ControlPlaneUnavailableError extends Error {
  constructor() {
    super("Control plane unavailable.");
    this.name = "ControlPlaneUnavailableError";
  }
}

export interface AutoStackHttpClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch: typeof globalThis.fetch;
}

export class AutoStackHttpClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: AutoStackHttpClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch;
  }

  async health(): Promise<HealthResponse> {
    const response = await this.#request("/v1/health", false);
    if (response.status !== 200 && response.status !== 503) {
      throw new ControlPlaneUnavailableError();
    }
    return this.#decode(response, HealthResponseSchema);
  }

  async listRuns(): Promise<ListRunsResponse> {
    const response = await this.#request("/v1/runs", true);
    if (response.status === 401) throw new CliAuthenticationError();
    if (!response.ok) throw new ControlPlaneUnavailableError();
    return this.#decode(response, ListRunsResponseSchema);
  }

  async #request(path: string, authenticated: boolean): Promise<Response> {
    try {
      return await this.#fetch(
        `${this.#baseUrl}${path}`,
        authenticated ? { headers: { Authorization: `Bearer ${this.#token}` } } : undefined
      );
    } catch {
      throw new ControlPlaneUnavailableError();
    }
  }

  async #decode<T>(response: Response, schema: { parse(value: unknown): T }): Promise<T> {
    try {
      return schema.parse(await response.json());
    } catch {
      throw new ControlPlaneUnavailableError();
    }
  }
}
