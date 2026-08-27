# AutoStack Stream S3 — Model Plane: Router and Credentials

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver `packages/model-router` — `createModelRouter(deps)` implementing `ModelRouterPort` over three transports (`vercel_ai_gateway`, `openrouter`, `direct` for OpenAI/Anthropic/xAI) with dynamic catalog discovery and capability filtering (spec §10.1), per-station policy evaluation (spec §10.2), ordered fallback recorded as route events (spec §15), usage normalization that keeps missing provider data unknown rather than estimated (spec §10.2), a taxonomy-conformant failure surface (`ModelRoutingError`), and a Keychain-pattern `credential-ref-store.ts` that fails closed without OS protection and resolves secrets only at the transport call site (spec §14.3).

**Architecture:** The router is a pure resolver plus a thin transport layer. Route configuration and policy come in as validated contract values; nothing is discovered from the network except _capability declarations_ and _pricing_, and every network read goes through an injected `fetch` so the gate suite is fixture-only. Discovery results live in a router-local `CatalogSnapshot` with explicit `fresh | stale` freshness, so a provider outage degrades to a stale-but-present catalog instead of an unresolvable route; only a fetch failure with no cached snapshot becomes a classified `ModelRoutingError`. Selection is a deterministic pipeline — policy-allowed routes → capability filter → budget filter → ordered preference — and each rejection stage owns exactly one taxonomy code, so `capability_unavailable`, `route_disabled`, and `budget_exceeded` are produced by structure rather than by prose. Invocation is fallback-aware: a caller-supplied attempt runs against the preferred route and, on a retryable failure, against each policy fallback in order, emitting one `ModelRouteFallback` per activation to an injected route-event sink and one `ModelUsageRecord` per terminal outcome to an injected usage sink, attributed from the request and never from the provider response. The credential store is the only component that ever holds plaintext; it hands transports a `resolveSecret` callback rather than a value, so a secret exists as a string only inside the AI SDK provider factory call and never in a router field, event, log line, or serialized structure.

**Tech Stack:** Node.js 24 LTS; TypeScript 5.9 strict; pnpm 10.27; Turborepo 2; Zod 4; Vercel AI SDK 5 (`ai`, `@ai-sdk/gateway`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@openrouter/ai-sdk-provider`); Vitest 4.

**Spec:** `docs/superpowers/specs/2026-08-20-autostack-design.md` §7 (CredentialRef), §10.1, §10.2, §14.3, §15, §17.1–17.3; master plan `docs/superpowers/plans/2026-08-26-autostack-milestone-a-parallel.md` "Stream S3"; contract map `docs/development/milestone-a-contract-audit.md` items 6–10 and 21.

**Base:** worktree `/Users/zidane/factory-s3`, branch `codex/milestone-a-s3-model-router`, cut from `02e5cff`. Baseline verified before planning: `pnpm install --frozen-lockfile` clean, `pnpm check` 12/12, `pnpm format:check` clean, `pnpm test` 21/21 tasks green (no runner-local flake on this run).

---

## Global constraints

Inherited verbatim from the master plan's Global constraints and the stream-lead protocol; restated here as the review checklist for every task.

- **Ownership.** Create/modify only `packages/model-router/**` and this plan document. Never touch `packages/contracts`, `packages/domain`, another stream's package, `apps/desktop`, root config, or CI. A blocking contract shape is an escalation, never a local workaround.
- **No cross-implementation imports.** Depend on `@autostack/contracts` and `@autostack/domain/testing` only.
- **Security.** No secrets in events, artifacts, logs, error messages, or serialized structures; fail closed when OS protection is unavailable; provider responses are untrusted input and never widen a capability, a permission, or a policy ceiling; never a shell string anywhere.
- **TDD.** Failing test first with the stated failure observed, then the minimal implementation, then a focused re-run, then full package verification, then one conventional commit per task.
- **Quality bars.** TypeScript strict; no `any`, non-null assertions, disabled tests, placeholders, or TODOs. `.strict()` on every Zod object. Small files per concern (≤400 lines typical). Injected clocks, ID factories, and `fetch` — no ambient time, randomness, or network in tests. 80% coverage floor on statements/branches/functions/lines.
- **No live network in the gate suite.** Every provider interaction in unit and integration tests goes through recorded HTTP fixtures served by an injected `fetch` double, following `apps/cli/src/http-client.ts` (`readonly fetch: typeof globalThis.fetch` on the options object). Live smoke for all four credential sets is Wave 2's job.

## Contract surface consumed (no additions planned)

Read from `@autostack/contracts` (`packages/contracts/src/model.ts` unless noted):

| Symbol                                                                                        | Line                           | Use in S3                                                                                    |
| --------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| `ModelRouterPort`                                                                             | `:372`                         | The interface `createModelRouter` implements — `resolve`, `getRoute`, `recordUsage`          |
| `ModelRouteSchema` / `ModelTransportSchema`                                                   | `:54` / `:48`                  | Route configuration admitted at construction; the three transport kinds                      |
| `ModelRouteContextSchema`                                                                     | `:64`                          | The resolve request: attribution + `requiredCapabilities`                                    |
| `ModelRouteSelectionSchema`                                                                   | `:76`                          | The resolve result                                                                           |
| `ModelCatalogEntrySchema`, `MODEL_MODALITIES`, `MODEL_FEATURES`                               | `:127`, `:111`, `:114`         | Capability declaration produced by discovery; the closed vocabularies filtering decides over |
| `ModelPolicySchema`                                                                           | `:318`                         | Per-station constraints: allowed/fallback routes, token + cost ceilings, reasoning level     |
| `ModelRouteFallbackSchema`                                                                    | `:230`                         | One record per fallback activation; `failureCode` is taxonomy-bound                          |
| `ModelUsageRecordSchema`, `ModelTokenUsageSchema`, `ModelTokenCountSchema`, `ModelCostSchema` | `:185`, `:175`, `:159`, `:164` | Normalized usage with `reported` / `unknown` states                                          |
| `ModelUsageSchema`                                                                            | `:86`                          | The flat legacy shape `ModelRouterPort.recordUsage` still takes                              |
| `MODEL_ROUTING_FAILURE_CODES`, `ModelRoutingFailureSchema`, `ModelRoutingError`               | `:220`, `:264`, `:299`         | The entire failure surface                                                                   |
| `CredentialRefSchema`, `CredentialRefIdSchema`                                                | `entities.ts:370`, `ids.ts:63` | What the credential store keys on                                                            |
| `SafeMetadataStringSchema`                                                                    | `secret-safety.ts`             | Already enforced inside the schemas above; S3 relies on it for operator text                 |

Read from `@autostack/domain/testing`: `createFakeModelRouter` — the behavioral reference the real router must match (Task 6 asserts parity).

**No contract additions are planned.** Three points where S3 works _within_ the existing shapes rather than proposing changes, recorded so review can check the reasoning rather than rediscover it:

1. **Two usage surfaces, deliberately.** `ModelRouterPort.recordUsage` takes the flat `ModelUsageSchema`, which cannot express "unknown". The normalized `ModelUsageRecord` therefore does not travel through the port; it goes to an injected `ModelUsageSink` owned by this package, exactly as `createFakeModelRouter` splits `recordedUsage` (flat, via the port) from `usageRecords` (normalized, produced internally). S3 implements both surfaces and changes neither contract.
2. **Route events go to an injected sink, not to `EVENT_TYPES`.** The contract audit's deferral table makes appending domain event types an orchestrator-owned change. `ModelRouteFallback` records therefore go to a `ModelRouteEventSink` interface this package owns; Wave 2 (I1) wires it to whatever durable surface exists then.
3. **Pricing is router-local, not a catalog field.** `ModelCatalogEntrySchema` has no pricing field, and the audit explicitly scoped the contract to the capability _declaration_. Cost-ceiling evaluation therefore reads a `RoutePricing` value carried in this package's `CatalogSnapshot`, populated from the discovery responses that report pricing (Gateway, OpenRouter) and absent for those that do not (OpenAI, Anthropic, xAI `/v1/models`). See DEC-2 for what "absent" means to a policy that sets `maxCostMicros`.

## Design decisions requiring orchestrator confirmation

These are judgment calls where the spec admits more than one reading. Each is implemented as written below unless the orchestrator rules otherwise; each is cheap to reverse because it is isolated to one module.

- **DEC-1 — Capability floor for providers that publish no capability metadata.** Spec §10.1 says each route "declares supported modalities and features discovered from the provider", but OpenAI's `/v1/models` and Anthropic's `/v1/models` return ids and display names only. Guessing capabilities from model-name substrings would be exactly the "unvalidated universal list" §10.1 forbids. **Decision:** a discovered model with no provider-published capability metadata gets the conservative floor — `inputModalities: ["text"]`, `outputModalities: ["text"]`, `features: []` — unless the operator has declared capabilities for it in the route's `declaredCapabilities` map (a router-local, versioned configuration input, not a contract change). The effect is fail-closed: an undeclared OpenAI model is simply not offered to a station that requires `tool_call`, rather than being offered and failing at call time. Gateway, OpenRouter, and xAI all publish modality/parameter metadata and need no declaration.
- **DEC-2 — Unknown pricing under a cost ceiling.** Spec §10.2 allows a policy to constrain "maximum estimated cost". When `policy.maxCostMicros` is set and a candidate route's pricing is unknown, the router cannot prove the ceiling holds. **Decision:** fail closed — that route is ineligible, and if the ceiling eliminates every candidate the resolve raises `budget_exceeded` (non-retryable, per the taxonomy refinement). A policy that sets no `maxCostMicros` is unaffected, so the default personal policy keeps working with direct providers.
- **DEC-3 — Where token ceilings bite.** `ModelRouteContext` carries no token demand, so `maxInputTokens`/`maxOutputTokens` cannot be evaluated at resolve time against a request. **Decision:** at resolve time they act as route-capability requirements (a route whose declared `maxOutputTokens` is below `policy.maxOutputTokens` cannot serve the policy's allowance and is ineligible); at invocation time they are enforced against the caller's stated demand, and an over-ceiling demand raises `budget_exceeded`. Both paths are tested.

## Escalations raised with this plan

- **ESC-1 (blocking for S1, not for S3) — `ModelRouterPort` has no model-invocation surface.** `ModelRouterPort` is `resolve` / `getRoute` / `recordUsage`, and `AgentHarnessPort` is documented as "Vendor-neutral lifecycle boundary. Model routing is intentionally a separate port." (`packages/contracts/src/agent.ts:404`). But S1's charter says its native harness makes "All model calls through `ModelRouterPort` — no direct SDK provider wiring in this package (that is S3's job)", and no contract lets a caller actually invoke a model. Meanwhile S3's own exit criteria require fallback-with-route-event and usage normalization, which are only observable if something _attempts_ a call. So S1 and S3 need an invocation boundary that today exists in neither package's contract.

  **What this plan does about it (no contract change, no invented cross-stream schema):** S3 exposes, in addition to `ModelRouterPort`, a higher-order runner

  ```ts
  runWithRoute<T>(
    request: ModelRunRequest,
    attempt: (handle: ModelRouteHandle) => Promise<T>
  ): Promise<ModelRunResult<T>>;
  ```

  where `ModelRouteHandle` is `{ routeRef, provider, model, languageModel }` and the caller supplies its own `generateText`/`streamText` call. Prompt and response shapes stay entirely out of `packages/model-router` — this package never authors a message, tool, or output schema — so no de-facto cross-stream interface is created here (the failure the audit's item 21 rationale describes).

  **The ask:** confirm this is the intended S1↔S3 seam, and rule on where `ModelRouteHandle` should live. If S1 is to depend on it by type, it belongs in `@autostack/contracts` as an orchestrator-applied append-only addition, and `languageModel` must be typed vendor-neutrally there (contracts must not import the AI SDK). If instead Wave 2's I1 composition is the intended wiring point, `ModelRouteHandle` stays exported from `@autostack/model-router` and this plan needs no change. **This does not block Tasks 1–8 or 10**; it affects only Task 9's exported signature, so implementation can start immediately.

- **ESC-2 (informational) — new dependencies mutate `pnpm-lock.yaml`.** No AI SDK package exists anywhere in the repo today (`grep` over every `package.json`: zero hits for `"ai"`, `@ai-sdk/*`, `@openrouter/*`). Adding them to `packages/model-router/package.json` necessarily rewrites the root `pnpm-lock.yaml`, which the protocol lists under untouchable root config. Reading this as the mechanical consequence of a package I own rather than a root-config edit; flagging so the orchestrator can rule otherwise before Task 1 lands. Exact versions are pinned in Task 1 and listed in the stream report for review.

- **ESC-3 (informational) — provider catalog fixtures are documentation-derived, not recorded.** Wave 1 forbids live calls, so I cannot record real responses from the five catalog endpoints. Fixtures are hand-authored from each provider's published response shape. Mitigation, implemented in Task 3/4: every parser is fail-closed — an unrecognized catalog payload produces a classified `provider_error`, never a guessed capability set — so a fixture that drifts from reality degrades to "route unavailable", not to "route silently mis-declared". Wave 2's live smoke is what proves the shapes; if the orchestrator can supply recorded payloads from the user's four credential sets, they replace the hand-authored fixtures verbatim.

## Risks

- **R1 — Discovery shape drift** (see ESC-3). Contained by fail-closed parsing plus one fixture file per endpoint, so a Wave 2 correction is a fixture edit, not a redesign.
- **R2 — Coverage on transport wiring.** The AI SDK provider factories are thin, and thin wiring is where coverage floors are usually missed. Task 9 tests each factory through the injected `fetch` (all AI SDK providers accept a `fetch` option), so the wiring is executed rather than mocked away.
- **R3 — Secret leakage through error paths.** The likeliest leak is not a log line but an exception message or a structured-clone of a store handle. Task 10 tests `String(error)`, `JSON.stringify`, and `util.inspect` output explicitly, on top of the round-trip and fail-closed cases.

---

## Task 1: Package scaffold, failure taxonomy builders, and HTTP classification

**Files:**

- Create: `packages/model-router/package.json`
- Create: `packages/model-router/tsconfig.json`
- Create: `packages/model-router/vitest.config.ts`
- Create: `packages/model-router/src/index.ts`
- Create: `packages/model-router/src/failure/routing-failure.ts`
- Create: `packages/model-router/src/failure/http-classification.ts`
- Test: `packages/model-router/test/routing-failure.test.ts`
- Test: `packages/model-router/test/http-classification.test.ts`

- [ ] **Step 1: Scaffold the package**

`package.json` mirrors `packages/runner-local/package.json` exactly in shape:

```json
{
  "name": "@autostack/model-router",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json --noEmit",
    "check": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage"
  },
  "dependencies": {
    "@autostack/contracts": "workspace:*",
    "ai": "^5.0.0",
    "@ai-sdk/anthropic": "^2.0.0",
    "@ai-sdk/gateway": "^1.0.0",
    "@ai-sdk/openai": "^2.0.0",
    "@openrouter/ai-sdk-provider": "^1.0.0"
  },
  "devDependencies": { "@autostack/domain": "workspace:*" }
}
```

Resolve each caret to the exact installed version after `pnpm install` and record the resolved set in `.superpowers/sdd/stream-report.md` (ESC-2). `tsconfig.json` and `vitest.config.ts` are copied from `packages/runner-local` unchanged (`types: ["node", "vitest/globals"]`, `include: ["src/**/*.ts", "test/**/*.ts"]`; the root `vitest.config.ts` already supplies the 80% thresholds).

- [ ] **Step 2: Add the failing taxonomy-builder test**

`test/routing-failure.test.ts` asserts one builder per taxonomy member and that each admits through `ModelRoutingFailureSchema`:

```ts
import { MODEL_ROUTING_FAILURE_CODES, ModelRoutingError } from "@autostack/contracts";
import {
  capabilityUnavailable,
  routeDisabled,
  budgetExceeded,
  rateLimited,
  providerError
} from "../src/failure/routing-failure.js";

it("raises a non-retryable error for every deterministic code", () => {
  for (const failure of [
    capabilityUnavailable({ required: ["tool_call"] }),
    routeDisabled({ routeRef: "route:openai", required: ["text"] }),
    budgetExceeded({ routeRef: "route:openai", reason: "cost ceiling" })
  ]) {
    expect(failure).toBeInstanceOf(ModelRoutingError);
    expect(failure.retryable).toBe(false);
  }
});

it("covers every declared taxonomy code", () => {
  expect(new Set(coveredCodes())).toEqual(new Set(MODEL_ROUTING_FAILURE_CODES));
});
```

`coveredCodes()` is exported from the module and enumerated from the builder table, so adding a taxonomy member to contracts without a builder fails this test rather than silently narrowing S3's failure surface.

Run:

```bash
pnpm --filter @autostack/model-router test -- routing-failure.test.ts
```

Expected failure: `Cannot find module '../src/failure/routing-failure.js'`.

- [ ] **Step 3: Implement the builders**

Each builder returns a `ModelRoutingError` constructed from a `ModelRoutingFailureSchema`-shaped object with `schemaVersion: 1`. Retryability is not a parameter for the four codes the contract refinement constrains — `capability_unavailable`, `route_disabled`, `budget_exceeded` are hard-coded `false` and `rate_limited` hard-coded `true`, so the refinement can never reject a builder's output. `providerError({ retryable, ... })` is the one builder taking retryability, since only the adapter knows whether a given provider fault was transient. Operator text is composed from safe values only (route refs, capability names, HTTP status codes) — never a response body, header, or URL, any of which could carry a credential.

- [ ] **Step 4: Add the failing HTTP-classification test**

`test/http-classification.test.ts` covers the response → code mapping:

| Condition                              | Code             | `retryable` |
| -------------------------------------- | ---------------- | ----------- |
| 429, or 503 with `retry-after`         | `rate_limited`   | `true`      |
| 500, 502, 503, 504                     | `provider_error` | `true`      |
| network throw / abort / malformed body | `provider_error` | `true`      |
| 400, 401, 403, 404, 422                | `provider_error` | `false`     |

Assert also that the produced message contains the status code and the route ref and contains neither the response body nor any header value.

- [ ] **Step 5: Implement `classifyTransportResponse` and verify**

```bash
pnpm --filter @autostack/model-router test
pnpm --filter @autostack/model-router check
pnpm format:check
```

- [ ] **Step 6: Commit**

```bash
git add packages/model-router && git commit -m "feat(model-router): scaffold the package and the routing failure taxonomy"
```

---

## Task 2: Route registry — `getRoute`, `recordUsage`, and admission

**Files:**

- Create: `packages/model-router/src/route-registry.ts`
- Test: `packages/model-router/test/route-registry.test.ts`

- [ ] **Step 1: Add the failing registry test**

Assert that `createRouteRegistry(routes)`:

- admits every route through `ModelRouteSchema.parse` at construction and throws on the first invalid one, naming the index but not the transport's `credentialRefId`;
- rejects duplicate `routeRef` values;
- returns a frozen route from `getRoute(routeRef)` and `undefined` for an unknown ref;
- returns routes in declaration order from `list()`, including disabled ones (disabled routes must stay visible — `route_disabled` is only distinguishable from `capability_unavailable` if the disabled route is still in the catalog).

Run:

```bash
pnpm --filter @autostack/model-router test -- route-registry.test.ts
```

Expected failure: module not found.

- [ ] **Step 2: Implement the registry**

Immutable: the constructor deep-freezes the parsed routes and every accessor returns a copy or a frozen value. No route is ever mutated after admission.

- [ ] **Step 3: Add the failing `recordUsage` test**

`recordUsage(usage: ModelUsage)` — the port's flat surface — parses through `ModelUsageSchema` and forwards to an injected `LegacyUsageSink`. Assert rejection of a payload that fails the schema and that the rejection message contains no field values.

- [ ] **Step 4: Implement, verify, commit**

```bash
pnpm --filter @autostack/model-router test
git add packages/model-router && git commit -m "feat(model-router): admit and index model routes"
```

---

## Task 3: Catalog discovery — aggregator transports (Gateway, OpenRouter)

**Files:**

- Create: `packages/model-router/src/catalog/catalog-types.ts`
- Create: `packages/model-router/src/catalog/gateway-catalog.ts`
- Create: `packages/model-router/src/catalog/openrouter-catalog.ts`
- Create: `packages/model-router/test/fixtures/gateway-models.json`
- Create: `packages/model-router/test/fixtures/openrouter-models.json`
- Create: `packages/model-router/test/support/fixture-fetch.ts`
- Test: `packages/model-router/test/gateway-catalog.test.ts`
- Test: `packages/model-router/test/openrouter-catalog.test.ts`

- [ ] **Step 1: Build the fixture-fetch double**

`test/support/fixture-fetch.ts` exports `createFixtureFetch(routes)` returning a `typeof globalThis.fetch` that matches on method + URL and returns a `Response` built from a fixture file, plus a recorded call log (`{ url, method, headerNames }` — **header names only, never values**, so a leaked credential cannot be asserted into existence by a test). Unmatched requests reject with a distinctive error, so an accidental live call fails loudly rather than escaping the suite. Also supports scripted status codes and a `throws` mode for network-failure cases.

- [ ] **Step 2: Add the failing Gateway catalog test**

`test/fixtures/gateway-models.json` holds a hand-authored `GET https://ai-gateway.vercel.sh/v1/models` payload with four entries covering: text-only, text+image input, a model declaring tool-calling and structured output, and a reasoning model with pricing. Assert `discoverGatewayCatalog({ route, fetch, now })`:

- issues exactly one GET to the gateway models URL with an `Authorization` header present (name asserted, value never read);
- returns one `ModelCatalogEntry` per payload entry, each passing `ModelCatalogEntrySchema.parse`, with `routeRef` set from the route and `discoveredAt` from the injected clock;
- maps provider modality strings into `MODEL_MODALITIES` and provider capability strings into `MODEL_FEATURES`, **dropping** unmapped values rather than passing them through (`ModelCatalogEntrySchema` would reject them, and silently widening the enum is the drift the closed enums exist to prevent);
- carries pricing into the snapshot's `RoutePricing` for entries that report it and omits it for those that do not;
- raises `provider_error` (retryable `true`) on a payload whose top-level shape does not parse, and `rate_limited` on HTTP 429.

Run:

```bash
pnpm --filter @autostack/model-router test -- gateway-catalog.test.ts
```

Expected failure: `discoverGatewayCatalog` does not exist.

- [ ] **Step 3: Implement the Gateway parser**

Parse the response with a `.strict()`-per-object Zod schema local to this module (provider payloads are untrusted input — spec §14.1). Unknown _entries_ are skipped with a counted reason; an unknown _envelope_ is a `provider_error`. Deduplicate by `providerModel`, keeping the first.

- [ ] **Step 4: Add the failing OpenRouter catalog test**

Same assertions against `GET https://openrouter.ai/api/v1/models`, with the fixture exercising OpenRouter's documented shape: `data[].id`, `.name`, `.context_length`, `.architecture.input_modalities`, `.architecture.output_modalities`, `.supported_parameters`, `.top_provider.max_completion_tokens`, `.pricing.prompt` / `.pricing.completion`. Add one case proving `supported_parameters` containing `tools` yields the `tool_call` feature and `reasoning` yields the `reasoning` feature, and one proving an unmapped parameter name is dropped.

- [ ] **Step 5: Implement, verify, commit**

```bash
pnpm --filter @autostack/model-router test
pnpm --filter @autostack/model-router check
git add packages/model-router && git commit -m "feat(model-router): discover gateway and openrouter model catalogs"
```

---

## Task 4: Catalog discovery — direct transports (OpenAI, Anthropic, xAI) and DEC-1

**Files:**

- Create: `packages/model-router/src/catalog/direct-catalog.ts`
- Create: `packages/model-router/src/catalog/declared-capabilities.ts`
- Create: `packages/model-router/test/fixtures/openai-models.json`
- Create: `packages/model-router/test/fixtures/anthropic-models.json`
- Create: `packages/model-router/test/fixtures/xai-models.json`
- Test: `packages/model-router/test/direct-catalog.test.ts`

- [ ] **Step 1: Add the failing direct-catalog test**

One `describe` per provider, driven from the route's `transport.protocol` + `transport.provider` + `transport.endpoint` (the endpoint is already refined by the contract to carry no credentials):

- **openai** (`openai_compatible` / `openai`) — `GET {endpoint}/models` returning `{ object: "list", data: [{ id, object, created, owned_by }] }`. Assert every entry lands at the DEC-1 conservative floor: `inputModalities: ["text"]`, `outputModalities: ["text"]`, `features: []`.
- **anthropic** (`anthropic` / `anthropic`) — `GET {endpoint}/v1/models` returning `{ data: [{ type, id, display_name, created_at }], has_more, first_id, last_id }`. Assert `displayName` comes from `display_name`, the same capability floor applies, and that a `has_more: true` page is followed via `after_id` for at most a bounded number of pages (assert the bound with a fixture that would otherwise loop).
- **xai** (`openai_compatible` / `xai`) — `GET {endpoint}/v1/language-models` returning entries with `input_modalities`, `output_modalities`, and pricing. Assert modalities are read from the provider rather than floored, and pricing lands in `RoutePricing`.

Then the DEC-1 override case: with `declaredCapabilities` supplying an entry for one OpenAI model, that model's catalog entry carries the declared modalities/features while its siblings stay at the floor. Assert a declared capability outside `MODEL_MODALITIES`/`MODEL_FEATURES` is rejected at construction, not at discovery.

Run:

```bash
pnpm --filter @autostack/model-router test -- direct-catalog.test.ts
```

Expected failure: `discoverDirectCatalog` does not exist.

- [ ] **Step 2: Implement the direct parsers and the declared-capability overlay**

One small parser per protocol behind a shared shape; the overlay is applied after parsing so a declaration can never resurrect a model the provider did not list. Same fail-closed envelope handling as Task 3.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @autostack/model-router test
git add packages/model-router && git commit -m "feat(model-router): discover direct provider catalogs with a conservative capability floor"
```

---

## Task 5: Catalog cache — freshness, stale-but-present, and classified fetch failure

**Files:**

- Create: `packages/model-router/src/catalog/catalog-cache.ts`
- Create: `packages/model-router/src/catalog/catalog-discovery.ts`
- Test: `packages/model-router/test/catalog-cache.test.ts`

- [ ] **Step 1: Add the failing cache test**

`createCatalogCache({ discover, now, ttlMs })` with an injected clock. Assert:

- a first read discovers and returns `{ freshness: "fresh", entries, discoveredAt }`;
- a read inside the TTL returns the cached snapshot without a second `fetch` call (asserted from the fixture-fetch call log);
- a read after the TTL rediscovers and returns `fresh`;
- **a rediscovery failure with a cached snapshot present returns that snapshot with `freshness: "stale"` and does not raise** — this is the charter's "stale-but-present cached catalog is representable";
- a rediscovery failure with **no** cached snapshot raises the classified `ModelRoutingError` from Task 1 (`provider_error` retryable, or `rate_limited` on 429), attributed with `routeRef`;
- concurrent reads during an in-flight discovery share one request (single-flight), asserted by two awaited reads producing one logged `fetch` call;
- a snapshot is never mutated after creation — a caller mutating the returned array cannot affect the next read.

Run:

```bash
pnpm --filter @autostack/model-router test -- catalog-cache.test.ts
```

Expected failure: module not found.

- [ ] **Step 2: Implement the cache and the per-transport discovery dispatcher**

`catalog-discovery.ts` switches on `route.transport.kind` (and, for `direct`, on `protocol`/`provider`) and delegates to Tasks 3–4. The switch is exhaustive over `ModelTransportSchema`'s discriminated union with a `never`-typed default, so a future transport kind is a compile error rather than a silent fallthrough.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @autostack/model-router test
pnpm --filter @autostack/model-router check
git add packages/model-router && git commit -m "feat(model-router): cache discovered catalogs with explicit staleness"
```

---

## Task 6: Capability filtering and selection — parity with the shared fake

**Files:**

- Create: `packages/model-router/src/catalog/capability-filter.ts`
- Create: `packages/model-router/src/selection/select-route.ts`
- Test: `packages/model-router/test/capability-filter.test.ts`
- Test: `packages/model-router/test/selection-parity.test.ts`

- [ ] **Step 1: Add the failing capability-filter test**

A route's declared capability set is the union of `inputModalities`, `outputModalities`, and `features` across its catalog entries — matching `declaredCapabilities` in `packages/domain/src/testing/fake-model-router.ts:67`. Assert:

- a context whose `requiredCapabilities` are all declared keeps the route;
- one missing capability drops it;
- an empty `requiredCapabilities` keeps every route;
- the filter reads only from `ModelCatalogEntry` values, never from route display names or transport fields.

- [ ] **Step 2: Add the failing selection-parity test**

This is the charter's "swapping fake→real changes nothing for S1/S4" requirement, made mechanical. A table of scenarios — each a set of `{ route, catalogEntry }` declarations plus a `ModelRouteContext` — is run through **both** `createFakeModelRouter` from `@autostack/domain/testing` **and** the real selection function, asserting identical outcomes:

| Scenario                                                      | Expected                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------- |
| Every capable route enabled                                   | same `routeRef` selected                                    |
| No route declares a required capability                       | `capability_unavailable`, `retryable: false`                |
| Capable routes exist, all `enabled: false`                    | `route_disabled`, `retryable: false`, `routeRef` attributed |
| Capable+enabled route exists alongside a capable+disabled one | selected, no failure                                        |
| Required capability declared only by a disabled route         | `route_disabled`, **not** `capability_unavailable`          |

The last row is the distinction the charter calls out by name; it fails loudly if the two orderings ever diverge.

Run:

```bash
pnpm --filter @autostack/model-router test -- selection-parity.test.ts
```

Expected failure: `selectRoute` does not exist.

- [ ] **Step 3: Implement `selectRoute`**

Ordered stages, each owning one failure code: capability filter → `capability_unavailable`; enabled filter → `route_disabled`. Policy and budget stages arrive in Task 7 and slot in _after_ the capability filter and _before_ the enabled filter is re-checked, so the parity table stays true. The result is a `ModelRouteSelectionSchema`-parsed value whose `reason` is composed from safe values only and whose `selectedAt` comes from the injected clock.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @autostack/model-router test
git add packages/model-router && git commit -m "feat(model-router): filter routes by declared capability and select deterministically"
```

---

## Task 7: Policy evaluation — allowed routes, ordering, reasoning, and ceilings

**Files:**

- Create: `packages/model-router/src/policy/evaluate-policy.ts`
- Create: `packages/model-router/src/policy/budget.ts`
- Test: `packages/model-router/test/evaluate-policy.test.ts`
- Test: `packages/model-router/test/budget.test.ts`

- [ ] **Step 1: Add the failing policy test**

Against a `ModelPolicy` parsed from `ModelPolicySchema`, assert:

- only routes in `allowedRouteRefs` are candidates; a route absent from the policy is excluded **before** the capability filter, so an out-of-policy route can never be the reason a station sees `capability_unavailable`;
- the preferred route is the first `allowedRouteRefs` entry that survives filtering, and `fallbackRouteRefs` supplies the _ordered_ remainder (the contract already refines fallbacks to be a subset of allowed);
- `reasoningLevel` other than `none` requires the `reasoning` feature in the route's declared set; routes without it are ineligible, and if that empties the candidate set the failure is `capability_unavailable` (the station needs a capability nothing offers) rather than a new code;
- a policy whose `stage` differs from the context's `stage` is rejected at the call boundary with a `TypeError` — a mismatched policy is a programming error in the composition root, not a routing failure.

- [ ] **Step 2: Add the failing budget test (DEC-2, DEC-3)**

- `maxCostMicros` set, candidate pricing known and under the ceiling → eligible.
- `maxCostMicros` set, candidate pricing known and over the ceiling → ineligible; all candidates over → `budget_exceeded`, `retryable: false`.
- `maxCostMicros` set, candidate pricing **unknown** → ineligible (DEC-2, fail closed); all candidates unknown → `budget_exceeded`.
- `maxCostMicros` unset, pricing unknown → eligible (a policy that sets no ceiling is not constrained by one).
- `maxOutputTokens` set above a route's declared `maxOutputTokens` → that route ineligible (DEC-3 resolve-time).
- A route with no declared `maxOutputTokens` under a policy that sets one → ineligible, same fail-closed rule.
- Invocation-time: a stated output demand above `policy.maxOutputTokens` → `budget_exceeded`, `retryable: false`.
- The `budget_exceeded` message names the ceiling and the route ref and contains no pricing arithmetic that could be mistaken for a quote.

Run:

```bash
pnpm --filter @autostack/model-router test -- budget.test.ts
```

Expected failure: module not found.

- [ ] **Step 3: Implement, re-run the Task 6 parity table, verify, commit**

The parity table from Task 6 must still pass unchanged (it uses no policy; policy defaults to "all routes allowed" when absent).

```bash
pnpm --filter @autostack/model-router test
pnpm --filter @autostack/model-router check
git add packages/model-router && git commit -m "feat(model-router): evaluate per-station policy and budget ceilings"
```

---

## Task 8: Fallback runner and route-event recording

**Files:**

- Create: `packages/model-router/src/fallback/fallback-runner.ts`
- Create: `packages/model-router/src/fallback/route-event-sink.ts`
- Test: `packages/model-router/test/fallback-runner.test.ts`

- [ ] **Step 1: Add the failing fallback test**

`runWithFallback({ order, context, attempt, sink, now, ids })` where `attempt` is an injected `(target: ModelRouteTarget) => Promise<T>` — a plain higher-order function, so this task is provider-independent and does not presuppose ESC-1's resolution. Assert:

- a first-attempt success records **no** fallback and calls `attempt` once;
- a retryable failure on the first target advances to the second and records exactly one `ModelRouteFallback`, parsed through `ModelRouteFallbackSchema`, with `from`/`to` set to the two targets, `failureCode` set to the raised `ModelRoutingError.code` (taxonomy-bound — the whole point of the post-charter revision), attribution copied from the context, and `occurredAt` from the injected clock;
- a **non-retryable** failure does not advance and records no fallback — falling back after `budget_exceeded` or `capability_unavailable` would spend money on a request the policy already refused;
- exhausting the order re-raises the _last_ failure, preserving its code and retryability;
- two fallbacks produce two records in activation order;
- the sink receiving a record is awaited, and a sink rejection propagates rather than being swallowed (spec §15 requires the route event to exist, so losing it silently is not acceptable);
- a degenerate order where two adjacent targets share route+model raises before calling `attempt` — the contract refinement would reject the record, and discovering that at record time would mean the attempt already ran.

Run:

```bash
pnpm --filter @autostack/model-router test -- fallback-runner.test.ts
```

Expected failure: module not found.

- [ ] **Step 2: Implement, verify, commit**

```bash
pnpm --filter @autostack/model-router test
git add packages/model-router && git commit -m "feat(model-router): record ordered fallback activations as route events"
```

---

## Task 9: Usage normalization

**Files:**

- Create: `packages/model-router/src/usage/normalize-usage.ts`
- Create: `packages/model-router/src/usage/usage-sink.ts`
- Test: `packages/model-router/test/normalize-usage.test.ts`

- [ ] **Step 1: Add the failing normalization test**

`normalizeUsage({ context, adapterId, requested, actual, providerUsage, latencyMs, outcome, now })` → `ModelUsageRecord`. Assert:

- **attribution is derived from the request, never from the provider response** — `workspaceId`, `runId`, `stageRunId`, `stage`, `routeRef`, `idempotencyKey` come from the context, and a `providerUsage` payload carrying conflicting values for any of them is ignored, not merged (spec §10.2, and the charter calls this out explicitly);
- a provider reporting all four token counts yields four `{ state: "reported", value }` entries;
- a provider reporting **none** yields four `{ state: "unknown" }` entries and `cost: { state: "unknown" }` — never zeros, which is exactly what the flat `ModelUsageSchema` would have silently produced;
- a provider reporting input and output but not cached/reasoning yields two `reported` and two `unknown` — partial data stays partial;
- a negative, non-integer, or non-numeric provider count becomes `unknown` rather than being coerced or clamped;
- `cost` is `reported` only when the provider reports a cost **or** the route's `RoutePricing` and the reported token counts together determine it exactly; a cost derived from an `unknown` token count is `unknown`;
- `requested.model` differs from `actual.model` after a fallback, and both survive into the record (this is what makes §15's "cost reporting reflects the actual provider/model" true);
- `outcome` is one of `succeeded | failed | cancelled` and a failed attempt still produces a record;
- every produced record passes `ModelUsageRecordSchema.parse`;
- the record contains no provider response text, request id from an untrusted field that fails `StableRefSchema`, or any header value.

Run:

```bash
pnpm --filter @autostack/model-router test -- normalize-usage.test.ts
```

Expected failure: module not found.

- [ ] **Step 2: Implement, verify, commit**

```bash
pnpm --filter @autostack/model-router test
git add packages/model-router && git commit -m "feat(model-router): normalize provider usage without estimating unknowns"
```

---

## Task 10: Transport clients over the Vercel AI SDK

**Files:**

- Create: `packages/model-router/src/transport/transport-client.ts`
- Create: `packages/model-router/src/transport/language-model-factory.ts`
- Test: `packages/model-router/test/language-model-factory.test.ts`

**Depends on ESC-1's ruling for the exported signature only** — the internal factory below is unaffected either way.

- [ ] **Step 1: Add the failing factory test**

`createLanguageModelFactory({ credentials, fetch })` returns `resolveLanguageModel(route): Promise<ModelRouteHandle>`. Using the fixture-fetch double as the AI SDK provider's `fetch` option, assert for each of the five transport configurations (gateway, openrouter, direct-openai, direct-anthropic, direct-xai):

- a language model is produced whose `provider` and `model` match the route's transport fields;
- driving a minimal `generateText` through it issues exactly one request to the expected provider URL, carrying an `Authorization` (or `x-api-key`, for Anthropic) header whose **name** is asserted and whose value is never read by the test;
- the secret is fetched from the credential store **at this call** — the store's `resolve` is called once per model construction and the factory holds no secret field afterwards (asserted by `JSON.stringify(factory)` and `util.inspect(handle)` containing no fragment of the fixture secret);
- an unknown `transport.kind` is a compile error (exhaustive switch) and, defensively, a `TypeError` at runtime;
- a provider HTTP error surfaces through `classifyTransportResponse` as a `ModelRoutingError`, not as a raw AI SDK error, so callers only ever see the taxonomy.

Run:

```bash
pnpm --filter @autostack/model-router test -- language-model-factory.test.ts
```

Expected failure: module not found.

- [ ] **Step 2: Implement the factory**

One small module per transport kind, each a call to the corresponding AI SDK provider factory with `{ apiKey, baseURL, fetch }`. `apiKey` is read from the injected credential resolver inside the factory call expression and is never assigned to a variable that outlives it.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @autostack/model-router test
pnpm --filter @autostack/model-router check
git add packages/model-router && git commit -m "feat(model-router): build language models per transport over the AI SDK"
```

---

## Task 11: Credential reference store

**Files:**

- Create: `packages/model-router/src/credential-ref-store.ts`
- Create: `packages/model-router/src/credential-file-layout.ts`
- Test: `packages/model-router/test/credential-ref-store.test.ts`

Follows `apps/desktop/src/main/credential-store.ts` — the same `SecretProtector` interface (`isAvailable`/`encrypt`/`decrypt`), the same `0o600` file / `0o700` directory modes, the same ownership and symlink checks, the same atomic `open(..., "wx")` + `link` write. **`apps/desktop` is not modified**; desktop wiring is Wave 2's.

- [ ] **Step 1: Add the failing round-trip test**

`createCredentialRefStore({ root, protector, now })` over a disposable temp directory and a fake protector (a reversible transform plus a toggleable `isAvailable`). Assert:

- `put(ref, secret)` then `resolve(ref)` returns the exact secret;
- `resolve` on an unknown `CredentialRefId` throws a store error naming the id and nothing else;
- only the `macos_keychain` variant of `CredentialRefSchema` is accepted; `vercel`, `server_encrypted`, and `external_vault` refs are refused with a clear "unsupported credential store" error (spec §14.3 scopes Milestone A local secrets to the Keychain, and silently accepting a store we do not implement would be the opposite of fail-closed);
- the on-disk filename is derived from a digest of the ref's `store` + `locator`, so a hostile `service`/`account` string cannot escape the root or collide with another entry — asserted with a locator containing `../`, a NUL byte, and a path separator.

Run:

```bash
pnpm --filter @autostack/model-router test -- credential-ref-store.test.ts
```

Expected failure: module not found.

- [ ] **Step 2: Add the failing fail-closed test**

With `protector.isAvailable()` returning `false`, assert that `put`, `resolve`, **and** store construction all throw, that nothing is written to the root, and that the thrown message contains no secret. Then assert the same for a protector whose `encrypt` returns an empty buffer and one whose `decrypt` throws — both are "protection unavailable", not "credential missing".

- [ ] **Step 3: Add the failing no-plaintext-at-rest and no-leak test**

- Read the raw file bytes after `put` and assert they contain no substring of the plaintext secret (checked at every offset, not just as a whole-buffer compare).
- Assert the directory mode is `0o700` and the file mode `0o600`, and that a pre-existing file with wider modes or foreign ownership is refused rather than read.
- Assert `JSON.stringify(store)`, `util.inspect(store, { depth: null })`, `String(store)`, and the message + stack of every error the store can throw contain no fragment of the secret (R3).
- Assert the store exposes no accessor returning a cached plaintext — `resolve` reads and decrypts from disk each time, so there is no in-memory secret to leak.
- Assert `delete(refId)` removes the file and that a subsequent `resolve` throws the unknown-id error.

- [ ] **Step 4: Implement, verify, commit**

```bash
pnpm --filter @autostack/model-router test
pnpm --filter @autostack/model-router check
git add packages/model-router && git commit -m "feat(model-router): store credential references behind an injected protector"
```

---

## Task 12: Compose `createModelRouter(deps)` and prove the three transports end to end

**Files:**

- Create: `packages/model-router/src/model-router.ts`
- Modify: `packages/model-router/src/index.ts`
- Test: `packages/model-router/test/model-router.test.ts`
- Test: `packages/model-router/test/transport-integration.test.ts`

- [ ] **Step 1: Add the failing composition test**

```ts
export interface ModelRouterDependencies {
  readonly routes: readonly ModelRoute[];
  readonly policies: readonly ModelPolicy[];
  readonly credentials: CredentialResolver;
  readonly routeEvents: ModelRouteEventSink;
  readonly usage: ModelUsageSink;
  readonly legacyUsage: LegacyUsageSink;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => string;
  readonly catalogTtlMs?: number;
  readonly declaredCapabilities?: DeclaredCapabilityMap;
}
export const createModelRouter: (deps: ModelRouterDependencies) => ModelRouter;
```

Assert `createModelRouter(deps)` satisfies `ModelRouterPort` structurally (a `const port: ModelRouterPort = router` assignment compiles) and that `resolve`/`getRoute`/`recordUsage` behave exactly as Tasks 2 and 6–7 specify when driven through the composed object.

- [ ] **Step 2: Add the failing per-transport integration test**

This is the charter's headline exit criterion: **catalog, selection, capability filtering, fallback-with-route-event, policy ceilings, and usage normalization each tested on fixtures for ALL THREE transports.** One `describe.each` over `["vercel_ai_gateway", "openrouter", "direct"]`, each running the same six assertions against that transport's fixtures:

1. discovery populates the catalog from the fixture and the entries pass `ModelCatalogEntrySchema`;
2. a station requiring a declared capability resolves to the expected route;
3. a station requiring an undeclared capability raises `capability_unavailable`;
4. a first-choice route failing with `rate_limited` falls back to the policy's next route, emitting exactly one taxonomy-coded `ModelRouteFallback` to the sink;
5. a policy cost ceiling below every candidate raises `budget_exceeded`, non-retryable;
6. a completed invocation emits one `ModelUsageRecord` whose `actual` names the fallback route and whose unreported counts are `unknown`.

For `direct`, the block runs three times — once per provider (openai, anthropic, xai) — so all five transport configurations are covered.

- [ ] **Step 3: Add the taxonomy-completeness test**

A single table asserting that every member of `MODEL_ROUTING_FAILURE_CODES` is reachable through the composed router with the correct `retryable` value, driven by a fixture scenario per code. This is the charter's "failure paths raise `ModelRoutingError` with correct code + retryable for every taxonomy member", made exhaustive against the contract's own enum rather than a hand-maintained list.

Run:

```bash
pnpm --filter @autostack/model-router test
```

Expected failure: `createModelRouter` does not exist.

- [ ] **Step 4: Implement the composition root, verify, commit**

`model-router.ts` wires the registry, cache, selection, policy, fallback runner, factory, and sinks; it contains no logic of its own beyond wiring, so the coverage floor is met by the units rather than by the composition.

```bash
pnpm --filter @autostack/model-router test
pnpm --filter @autostack/model-router check
git add packages/model-router && git commit -m "feat(model-router): compose the router across all three transports"
```

---

## Task 13: Gate pass, coverage, and stream report

- [ ] **Step 1: Full gate suite from the worktree root**

```bash
pnpm format:check
pnpm check
pnpm build --filter '!@autostack/desktop'
pnpm --filter @autostack/model-router test:coverage
pnpm test
```

All green; coverage ≥80% on statements, branches, functions, and lines for `@autostack/model-router`. If `pnpm test` trips the known runner-local load flake, re-run once and note it (it did not trip on the pre-plan baseline).

- [ ] **Step 2: Self-review pass**

Against the charter and the global constraints: no scope creep beyond `packages/model-router/**`; no TODO/placeholder/disabled test; no `any` or non-null assertion; no secret reachable from any event, log, error, or serialized value; every provider payload parsed as untrusted input; no shell string anywhere; pristine test output (no unhandled rejections, no stray console writes); `git diff --stat 02e5cff..HEAD` touches only `packages/model-router/**`, `docs/superpowers/plans/2026-08-26-autostack-s3-model-router.md`, and `pnpm-lock.yaml` (ESC-2).

- [ ] **Step 3: Write `.superpowers/sdd/stream-report.md` and reply MERGE_READY**

Report carries: exit-criterion-by-exit-criterion evidence, the resolved dependency versions, the DEC-1/2/3 decisions as implemented, ESC-1's resolution, coverage numbers, and the full gate output.

---

## Exit criteria (charter, restated as a checklist)

- [ ] Catalog, selection, capability filtering, fallback-with-route-event, policy ceilings, and usage normalization each tested on fixtures for `vercel_ai_gateway`, `openrouter`, and `direct` (Task 12 Step 2).
- [ ] Every member of `MODEL_ROUTING_FAILURE_CODES` reachable with the correct `retryable` value (Task 12 Step 3).
- [ ] Selection parity with `createFakeModelRouter`, including the `capability_unavailable` vs `route_disabled` distinction (Task 6 Step 2).
- [ ] Credential store: protector round-trip, fail-closed without OS protection, no plaintext at rest, no leak through serialization or error text (Task 11).
- [ ] `apps/desktop` untouched.
- [ ] `pnpm format:check`, `pnpm check`, `pnpm build` (excluding desktop), `pnpm --filter @autostack/model-router test:coverage` ≥80%, and root `pnpm test` all green (Task 13).
