import { createAnthropic } from "@ai-sdk/anthropic";
import { createGateway } from "@ai-sdk/gateway";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import type { ModelRoute } from "@autostack/contracts";

import type { CredentialResolver } from "../catalog/catalog-types.js";
import { pinnedModel } from "../route-registry.js";

/**
 * The structural shape of a built model. Inferred from `@ai-sdk/openai`'s own return type rather
 * than imported from `@ai-sdk/provider` — this package does not depend on that package directly, and
 * every AI SDK provider factory returns the same `LanguageModelV2` shape it declares. `@openrouter/
 * ai-sdk-provider` types its `providerMetadata` slightly looser than that shape under this project's
 * `exactOptionalPropertyTypes`, so its branch below is reconciled to this alias explicitly; this is
 * a type-interop cast between two AI SDK packages' own declarations, not a bypass of any validation
 * this codebase performs.
 */
type LanguageModelHandle = ReturnType<ReturnType<typeof createOpenAI>["chat"]>;

/**
 * Builds the Vercel AI SDK language model for one route's transport (Task 10, ESC-1). The built
 * model is never exported by name from `@ai-sdk/provider`, and `LanguageModelHandle` stays internal
 * to `packages/model-router`: the built handle never crosses `ModelInferencePort`, so no vendor SDK
 * type reaches S1.
 *
 * The credential is resolved from `credentials` **inside** the object-literal expression passed to
 * each provider factory, never assigned to a variable that outlives the call. This is one of the two
 * legitimate credential call sites (the other is catalog discovery, Tasks 3-5); the factory itself
 * holds no secret field once `build` returns, and `build` resolves the credential exactly once per
 * model construction.
 */
export interface LanguageModelFactoryOptions {
  readonly credentials: CredentialResolver;
  readonly fetch: typeof globalThis.fetch;
}

export const createLanguageModelFactory = (options: LanguageModelFactoryOptions) => {
  const build = async (route: ModelRoute): Promise<LanguageModelHandle> => {
    const modelId = pinnedModel(route);
    const transport = route.transport;

    switch (transport.kind) {
      case "vercel_ai_gateway": {
        const provider = createGateway({
          apiKey: await options.credentials.resolve(transport.credentialRefId),
          fetch: options.fetch
        });
        return provider.languageModel(modelId) as LanguageModelHandle;
      }
      case "openrouter": {
        const provider = createOpenRouter({
          apiKey: await options.credentials.resolve(transport.credentialRefId),
          fetch: options.fetch
        });
        return provider.chat(modelId) as LanguageModelHandle;
      }
      case "direct": {
        if (transport.protocol === "anthropic") {
          const provider = createAnthropic({
            apiKey: await options.credentials.resolve(transport.credentialRefId),
            baseURL: transport.endpoint,
            fetch: options.fetch
          });
          return provider(modelId) as LanguageModelHandle;
        }
        if (transport.protocol === "openai_compatible") {
          const provider = createOpenAI({
            apiKey: await options.credentials.resolve(transport.credentialRefId),
            baseURL: transport.endpoint,
            fetch: options.fetch
          });
          return provider.chat(modelId);
        }
        throw new TypeError(
          `Route ${route.routeRef} uses an unsupported direct protocol "${transport.protocol}".`
        );
      }
      default: {
        const exhaustive: never = transport;
        throw new TypeError(
          `Unknown transport kind for route ${route.routeRef}: ${String((exhaustive as { kind?: unknown }).kind)}`
        );
      }
    }
  };

  return { build };
};

export type LanguageModelFactory = ReturnType<typeof createLanguageModelFactory>;
export type { LanguageModelHandle };
