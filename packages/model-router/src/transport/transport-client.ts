import { generateText, type FinishReason, type ModelMessage as AiModelMessage } from "ai";

import {
  ModelInferenceRequestSchema,
  admitModelInferenceResult,
  type ModelFinishReason,
  type ModelInferencePort,
  type ModelInferenceRequest,
  type ModelInferenceResult,
  type ModelMessage,
  type ModelRoute
} from "@autostack/contracts";

import { classifyTransportResponse } from "../failure/http-classification.js";
import type { RouteRegistry } from "../route-registry.js";
import {
  createLanguageModelFactory,
  type LanguageModelFactoryOptions
} from "./language-model-factory.js";

/**
 * Implements `ModelInferencePort` (ESC-1) over the internal language-model factory. `run` reads
 * `request.selection.routeRef` to find the already-admitted route, builds the language model for its
 * transport, issues exactly one `generateText` — no streaming anywhere; Milestone A's stations
 * produce one document per call and a partial document is a failure, not a state — and returns a
 * result admitted through `admitModelInferenceResult`.
 */
export interface CreateModelInferenceOptions extends LanguageModelFactoryOptions {
  readonly routes: RouteRegistry;
  readonly now: () => string;
}

/**
 * Maps the AI SDK's own normalized finish reason into the closed `ModelFinishReasonSchema` enum.
 * Fails closed: `tool-calls`, `other`, and `unknown` are provider signals this taxonomy has no member
 * for, so they become `error` rather than being widened into `stop` — reporting a truncated or
 * filtered generation as a clean completion would be worse than reporting it as a failure.
 */
const FINISH_REASON_MAP: Readonly<Partial<Record<FinishReason, ModelFinishReason>>> = {
  stop: "stop",
  length: "length",
  "content-filter": "content_filter",
  error: "error"
};

const mapFinishReason = (raw: FinishReason): ModelFinishReason => FINISH_REASON_MAP[raw] ?? "error";

/**
 * Every branch narrows `role` to its own literal, so the returned object matches the AI SDK union.
 * `ModelMessageRoleSchema` has exactly three members, so eliminating the first two leaves the third
 * narrowed by TypeScript with no `default` needed — the request was already admitted through
 * `ModelInferenceRequestSchema` before this runs, so a fourth role can never reach here.
 */
const toAiMessage = (message: ModelMessage): AiModelMessage => {
  if (message.role === "system") return { role: "system", content: message.content };
  if (message.role === "user") return { role: "user", content: message.content };
  return { role: "assistant", content: message.content };
};

/** A provider-reported measurement stays `unknown` unless it is a genuine nonnegative integer. */
const tokenCount = (value: number | undefined) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? ({ state: "reported", value } as const)
    : ({ state: "unknown" } as const);

const readStatusCode = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" ? value : undefined;
};

const readResponseHeaders = (error: unknown): Record<string, string> => {
  if (typeof error !== "object" || error === null || !("responseHeaders" in error)) return {};
  const value = (error as { responseHeaders?: unknown }).responseHeaders;
  return typeof value === "object" && value !== null ? (value as Record<string, string>) : {};
};

/**
 * Classifies whatever `generateText` threw into the taxonomy so every failure this port raises is a
 * `ModelRoutingError`, never a raw AI SDK error. A thrown error carrying a numeric `statusCode` is an
 * HTTP fault — true for every provider here, including the Gateway provider's own error classes,
 * which are not `APICallError` instances but do carry `statusCode` — and is classified as an HTTP
 * response; anything else is a genuine network throw. A 2xx `statusCode` on a *thrown* error can only
 * mean the response body failed to parse, since a successful parse never throws.
 */
const toRoutingError = (routeRef: string, error: unknown) => {
  const statusCode = readStatusCode(error);
  if (statusCode === undefined) {
    return classifyTransportResponse({ routeRef, networkError: error });
  }
  return classifyTransportResponse({
    routeRef,
    status: statusCode,
    headers: new Headers(readResponseHeaders(error)),
    malformedBody: statusCode >= 200 && statusCode < 300
  });
};

/** The provider name attributed to a route's transport — never read from the built SDK model. */
const routeProviderName = (route: ModelRoute): string =>
  route.transport.kind === "direct" ? route.transport.provider : route.transport.kind;

export const createModelInference = (options: CreateModelInferenceOptions): ModelInferencePort => {
  const factory = createLanguageModelFactory({
    credentials: options.credentials,
    fetch: options.fetch
  });

  const run = async (request: ModelInferenceRequest): Promise<ModelInferenceResult> => {
    const admittedRequest = ModelInferenceRequestSchema.parse(request);
    const routeRef = admittedRequest.selection.routeRef;
    const route = options.routes.getRoute(routeRef);
    if (route === undefined) {
      throw new TypeError(
        `Model inference request resolved to an unconfigured route "${routeRef}".`
      );
    }

    const model = await factory.build(route);

    const startedAtMs = Date.now();
    let generated;
    try {
      generated = await generateText({
        model,
        messages: admittedRequest.messages.map(toAiMessage),
        maxOutputTokens: admittedRequest.options.maxOutputTokens,
        maxRetries: 0
      });
    } catch (error) {
      throw toRoutingError(routeRef, error);
    }
    const latencyMs = Math.max(0, Date.now() - startedAtMs);

    const candidate = {
      schemaVersion: 1 as const,
      idempotencyKey: admittedRequest.idempotencyKey,
      routeRef,
      content: generated.text,
      actual: {
        provider: routeProviderName(route),
        model: generated.response.modelId,
        providerRequestId: generated.response.id
      },
      tokens: {
        input: tokenCount(generated.usage.inputTokens),
        output: tokenCount(generated.usage.outputTokens),
        cachedInput: tokenCount(generated.usage.cachedInputTokens),
        reasoning: tokenCount(generated.usage.reasoningTokens)
      },
      cost: { state: "unknown" as const },
      finishReason: mapFinishReason(generated.finishReason),
      latencyMs,
      completedAt: options.now()
    };

    return admitModelInferenceResult(admittedRequest, candidate);
  };

  return { run };
};
