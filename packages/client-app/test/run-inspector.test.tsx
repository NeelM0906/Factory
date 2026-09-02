// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgentHarnessProfileSchema,
  EnvironmentSchema,
  ModelPolicySchema,
  ModelRouteFallbackSchema,
  ModelRouteSelectionSchema,
  ModelUsageRecordSchema,
  SourceRefSchema,
  createId,
  type AgentHarnessProfile,
  type Environment,
  type ModelCost,
  type ModelPolicy,
  type ModelRouteFallback,
  type ModelRouteSelection,
  type ModelTokenCount,
  type ModelUsageRecord,
  type SourceRef
} from "@autostack/contracts";

import { RunInspector, type RunInspectorProps } from "../src/inspector/run-inspector.js";

afterEach(cleanup);

const uuid = (counter: number): string => {
  const hex = counter.toString(16).padStart(30, "0");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(12, 15)}`,
    `8${hex.slice(15, 18)}`,
    hex.slice(18, 30)
  ].join("-");
};

const workspaceId = createId("workspace", uuid(1));
const runId = createId("run", uuid(2));
const stageRunId = createId("stageRun", uuid(3));

const OCCURRED_AT = "2026-08-26T00:00:00.000Z";

function buildHarness(overrides: Partial<AgentHarnessProfile> = {}): AgentHarnessProfile {
  return AgentHarnessProfileSchema.parse({
    schemaVersion: 1,
    descriptor: {
      schemaVersion: 1,
      adapterId: "claude.local.v1",
      kind: "claude",
      displayName: "Claude Code",
      capabilities: { resume: true, steering: true, permissions: false, structuredPlans: true }
    },
    selection: { modelSelection: true, reasoningSelection: true, permissionModes: [] },
    availability: { installed: true, authenticated: true, checkedAt: OCCURRED_AT },
    ...overrides
  });
}

function buildRouteSelection(overrides: Partial<ModelRouteSelection> = {}): ModelRouteSelection {
  return ModelRouteSelectionSchema.parse({
    schemaVersion: 1,
    idempotencyKey: "idem-route-1",
    routeRef: "route.default",
    reason: "policy-selected default route",
    selectedAt: OCCURRED_AT,
    ...overrides
  });
}

function buildFallback(overrides: Partial<ModelRouteFallback> = {}): ModelRouteFallback {
  return ModelRouteFallbackSchema.parse({
    schemaVersion: 1,
    idempotencyKey: "idem-route-1",
    workspaceId,
    runId,
    stageRunId,
    from: { routeRef: "route.default", model: "gpt-5" },
    to: { routeRef: "route.backup", model: "gpt-5-mini" },
    failureCode: "rate_limited",
    reason: "primary route rate limited",
    occurredAt: OCCURRED_AT,
    ...overrides
  });
}

function buildEnvironment(overrides: Partial<Environment> = {}): Environment {
  return EnvironmentSchema.parse({
    schemaVersion: 1,
    id: createId("environment", uuid(4)),
    workspaceId,
    runId,
    runnerId: "runner-1",
    repositoryRef: "github.com/acme/widgets",
    sourceCommit: "a".repeat(40),
    branch: "main",
    networkPolicy: "restricted",
    resourceLimits: { cpu: 2, memoryMb: 4096, durationSeconds: 3600 },
    createdAt: OCCURRED_AT,
    ...overrides
  });
}

function buildUsageRecord(
  overrides: {
    tokens?: Partial<{
      input: ModelTokenCount;
      output: ModelTokenCount;
      cachedInput: ModelTokenCount;
      reasoning: ModelTokenCount;
    }>;
    cost?: ModelCost;
  } = {}
): ModelUsageRecord {
  const unknownToken: ModelTokenCount = { state: "unknown" };
  return ModelUsageRecordSchema.parse({
    schemaVersion: 1,
    idempotencyKey: "idem-usage-1",
    workspaceId,
    runId,
    stageRunId,
    stage: "implement",
    adapterId: "adapter.codex",
    routeRef: "route.default",
    requested: { model: "gpt-5" },
    actual: { provider: "openai", model: "gpt-5" },
    tokens: {
      input: overrides.tokens?.input ?? unknownToken,
      output: overrides.tokens?.output ?? unknownToken,
      cachedInput: overrides.tokens?.cachedInput ?? unknownToken,
      reasoning: overrides.tokens?.reasoning ?? unknownToken
    },
    cost: overrides.cost ?? { state: "unknown" },
    latencyMs: 100,
    outcome: "succeeded",
    recordedAt: OCCURRED_AT
  });
}

function buildPolicy(overrides: Partial<ModelPolicy> = {}): ModelPolicy {
  return ModelPolicySchema.parse({
    schemaVersion: 1,
    policyRef: "policy.default",
    stage: "implement",
    allowedRouteRefs: ["route.b", "route.a"],
    fallbackRouteRefs: ["route.b"],
    maxInputTokens: 100_000,
    maxOutputTokens: 8_000,
    maxCostMicros: 500_000,
    reasoningLevel: "medium",
    ...overrides
  });
}

const MANUAL_SOURCE: SourceRef = SourceRefSchema.parse({ kind: "manual", client: "cli" });
const GITHUB_SOURCE: SourceRef = SourceRefSchema.parse({
  kind: "github",
  repositoryFullName: "acme/widgets",
  issueNumber: 42,
  deliveryId: "delivery-1",
  url: "https://github.com/acme/widgets/issues/42"
});
const SLACK_SOURCE: SourceRef = SourceRefSchema.parse({
  kind: "slack",
  slackWorkspaceId: "T123",
  channelId: "C456",
  threadTs: "1700000000.000100",
  deliveryId: "delivery-2"
});
const API_SOURCE: SourceRef = SourceRefSchema.parse({
  kind: "api",
  clientId: "client-1",
  deliveryId: "delivery-3"
});

function baseProps(overrides: Partial<RunInspectorProps> = {}): RunInspectorProps {
  return {
    harness: buildHarness(),
    routeSelection: buildRouteSelection(),
    routeFallback: undefined,
    environment: buildEnvironment(),
    usage: undefined,
    policy: buildPolicy(),
    source: MANUAL_SOURCE,
    workflowVersion: "v1.2.0",
    adapterId: "claude.local.v1",
    ...overrides
  };
}

function section(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

describe("RunInspector — six labelled sections", () => {
  it("renders all six sections, labelled per spec §4.1", () => {
    render(<RunInspector {...baseProps()} />);

    for (const name of ["Harness", "Model route", "Environment", "Usage", "Policy", "Provenance"]) {
      expect(screen.getByRole("region", { name })).toBeInTheDocument();
    }
  });
});

describe("RunInspector — harness (spec §9.1, audit item 1)", () => {
  it("renders an undeclared capability's name in the DOM with an unavailable marker element (fourth vector)", () => {
    const harness = buildHarness({
      descriptor: {
        schemaVersion: 1,
        adapterId: "claude.local.v1",
        kind: "claude",
        displayName: "Claude Code",
        capabilities: { resume: true, steering: true, permissions: false, structuredPlans: true }
      }
    });

    render(<RunInspector {...baseProps({ harness })} />);

    const dt = within(section("Harness")).getByText("Permissions", { selector: "dt" });
    expect(dt).toBeInTheDocument();
    const dd = dt.nextElementSibling;
    expect(dd).not.toBeNull();
    expect(dd?.textContent).toBe("Unavailable");
  });

  it("renders a declared capability as available (positive companion)", () => {
    render(<RunInspector {...baseProps()} />);

    const dt = within(section("Harness")).getByText("Resume", { selector: "dt" });
    const dd = dt.nextElementSibling;
    expect(dd?.textContent).toBe("Available");
  });

  it("renders installed/authenticated status separately from capability rows", () => {
    const harness = buildHarness({
      availability: { installed: true, authenticated: false, checkedAt: OCCURRED_AT }
    });

    render(<RunInspector {...baseProps({ harness })} />);

    const harnessSection = section("Harness");
    expect(
      within(harnessSection).getByText("Installed", { selector: "dt" }).nextElementSibling
        ?.textContent
    ).toBe("Yes");
    expect(
      within(harnessSection).getByText("Authenticated", { selector: "dt" }).nextElementSibling
        ?.textContent
    ).toBe("No");
  });

  it("renders Installed: No when the harness is not installed (not authenticated either, per the contract invariant)", () => {
    const harness = buildHarness({
      availability: { installed: false, authenticated: false, checkedAt: OCCURRED_AT }
    });

    render(<RunInspector {...baseProps({ harness })} />);

    const harnessSection = section("Harness");
    expect(
      within(harnessSection).getByText("Installed", { selector: "dt" }).nextElementSibling
        ?.textContent
    ).toBe("No");
    expect(
      within(harnessSection).getByText("Authenticated", { selector: "dt" }).nextElementSibling
        ?.textContent
    ).toBe("No");
  });
});

describe("RunInspector — model route (audit item 21)", () => {
  it("renders no fallback row at all when there is no fallback (element absence, not Not recorded)", () => {
    render(<RunInspector {...baseProps({ routeFallback: undefined })} />);

    const routeSection = section("Model route");
    expect(within(routeSection).queryByText("Failure code", { selector: "dt" })).toBeNull();
  });

  it("renders the fallback's failureCode from the closed taxonomy when a fallback occurred", () => {
    const fallback = buildFallback({ failureCode: "rate_limited" });

    render(<RunInspector {...baseProps({ routeFallback: fallback })} />);

    const routeSection = section("Model route");
    const dt = within(routeSection).getByText("Failure code", { selector: "dt" });
    expect(dt.nextElementSibling?.textContent).toBe("rate_limited");
  });
});

describe("RunInspector — environment", () => {
  it("renders a named state when no environment has been provisioned yet", () => {
    render(<RunInspector {...baseProps({ environment: undefined })} />);

    expect(within(section("Environment")).getByText(/not yet provisioned/i)).toBeInTheDocument();
  });

  it("renders branch, base commit, network policy, and resource limits when provisioned", () => {
    const environment = buildEnvironment({
      branch: "feature/x",
      sourceCommit: "b".repeat(40),
      networkPolicy: "host",
      resourceLimits: { cpu: 4, memoryMb: 8192, durationSeconds: 7200 }
    });

    render(<RunInspector {...baseProps({ environment })} />);

    const environmentSection = section("Environment");
    expect(within(environmentSection).getByText("feature/x")).toBeInTheDocument();
    expect(within(environmentSection).getByText("b".repeat(40))).toBeInTheDocument();
    expect(within(environmentSection).getByText("host")).toBeInTheDocument();
    expect(within(environmentSection).getByText("4")).toBeInTheDocument();
    expect(within(environmentSection).getByText("8192")).toBeInTheDocument();
    expect(within(environmentSection).getByText("7200")).toBeInTheDocument();
  });
});

describe("RunInspector — usage (spec §10.2, plan's load-bearing test)", () => {
  it("renders a named state when there is no usage record yet", () => {
    render(<RunInspector {...baseProps({ usage: undefined })} />);

    expect(within(section("Usage")).getByText(/no usage recorded yet/i)).toBeInTheDocument();
  });

  it('renders "Not recorded" in the cost field and no "0" there, even while a token count elsewhere is a real 0', () => {
    const usage = buildUsageRecord({
      tokens: { input: { state: "reported", value: 0 } },
      cost: { state: "unknown" }
    });

    render(<RunInspector {...baseProps({ usage })} />);

    const usageSection = section("Usage");
    // Scoped to the Cost field's own element — not the whole pane, since the input-tokens row
    // legitimately contains "0" right next to it.
    const costDd = within(usageSection).getByText("Cost", { selector: "dt" }).nextElementSibling;
    expect(costDd?.textContent).toBe("Not recorded");
    expect(costDd?.textContent).not.toContain("0");
    // The token count of 0 elsewhere in the same pane is legitimate and still shows as 0.
    const inputDd = within(usageSection).getByText("Input tokens", {
      selector: "dt"
    }).nextElementSibling;
    expect(inputDd?.textContent).toBe("0");
  });

  it("renders reported tokens and a reported cost as their exact values", () => {
    const usage = buildUsageRecord({
      tokens: {
        input: { state: "reported", value: 120 },
        output: { state: "reported", value: 340 }
      },
      cost: { state: "reported", currency: "USD", micros: 1_234_567 }
    });

    render(<RunInspector {...baseProps({ usage })} />);

    const usageSection = section("Usage");
    expect(
      within(usageSection).getByText("Input tokens", { selector: "dt" }).nextElementSibling
        ?.textContent
    ).toBe("120");
    expect(
      within(usageSection).getByText("Output tokens", { selector: "dt" }).nextElementSibling
        ?.textContent
    ).toBe("340");
    expect(
      within(usageSection).getByText("Cost", { selector: "dt" }).nextElementSibling?.textContent
    ).toBe("$1.234567");
  });
});

describe("RunInspector — policy (read-only, spec §9.3 pin)", () => {
  it("renders allowed routes in the policy's own authored order, never sorted", () => {
    const policy = buildPolicy({ allowedRouteRefs: ["route.b", "route.a"] });

    render(<RunInspector {...baseProps({ policy })} />);

    const dt = within(section("Policy")).getByText("Allowed routes", { selector: "dt" });
    expect(dt.nextElementSibling?.textContent).toBe("route.b, route.a");
  });

  it("renders fallback routes in authored order and ceilings/reasoning level when present", () => {
    const policy = buildPolicy({
      allowedRouteRefs: ["route.b", "route.a"],
      fallbackRouteRefs: ["route.b"],
      maxInputTokens: 100_000,
      maxOutputTokens: 8_000,
      maxCostMicros: 500_000,
      reasoningLevel: "high"
    });

    render(<RunInspector {...baseProps({ policy })} />);

    const policySection = section("Policy");
    expect(
      within(policySection).getByText("Fallback routes", { selector: "dt" }).nextElementSibling
        ?.textContent
    ).toBe("route.b");
    expect(
      within(policySection).getByText("Max input tokens", { selector: "dt" }).nextElementSibling
        ?.textContent
    ).toBe("100000");
    expect(
      within(policySection).getByText("Max output tokens", { selector: "dt" }).nextElementSibling
        ?.textContent
    ).toBe("8000");
    expect(
      within(policySection).getByText("Max cost", { selector: "dt" }).nextElementSibling
        ?.textContent
    ).toBe("$0.500000");
    expect(
      within(policySection).getByText("Reasoning level", { selector: "dt" }).nextElementSibling
        ?.textContent
    ).toBe("high");
  });

  it('renders "None" for an empty fallback list and "Not recorded" for absent ceilings', () => {
    const policy = buildPolicy({
      fallbackRouteRefs: [],
      maxInputTokens: undefined,
      maxOutputTokens: undefined,
      maxCostMicros: undefined,
      reasoningLevel: undefined
    });

    render(<RunInspector {...baseProps({ policy })} />);

    const policySection = section("Policy");
    expect(
      within(policySection).getByText("Fallback routes", { selector: "dt" }).nextElementSibling
        ?.textContent
    ).toBe("None");
    expect(
      within(policySection).getByText("Max cost", { selector: "dt" }).nextElementSibling
        ?.textContent
    ).toBe("Not recorded");
  });
});

describe("RunInspector — provenance, every SourceRef kind (untrusted text as text children only)", () => {
  it("renders a manual source", () => {
    render(<RunInspector {...baseProps({ source: MANUAL_SOURCE })} />);

    const provenanceSection = section("Provenance");
    expect(
      within(provenanceSection).getByText("Source", { selector: "dt" }).nextElementSibling
        ?.textContent
    ).toBe("Manual");
    expect(within(provenanceSection).getByText("cli")).toBeInTheDocument();
  });

  it("renders a github source", () => {
    render(<RunInspector {...baseProps({ source: GITHUB_SOURCE })} />);

    const provenanceSection = section("Provenance");
    expect(
      within(provenanceSection).getByText("Source", { selector: "dt" }).nextElementSibling
        ?.textContent
    ).toBe("GitHub");
    expect(within(provenanceSection).getByText("acme/widgets")).toBeInTheDocument();
    expect(within(provenanceSection).getByText("42")).toBeInTheDocument();
    expect(within(provenanceSection).getByText("delivery-1")).toBeInTheDocument();
  });

  it("renders a slack source", () => {
    render(<RunInspector {...baseProps({ source: SLACK_SOURCE })} />);

    const provenanceSection = section("Provenance");
    expect(
      within(provenanceSection).getByText("Source", { selector: "dt" }).nextElementSibling
        ?.textContent
    ).toBe("Slack");
    expect(within(provenanceSection).getByText("T123")).toBeInTheDocument();
    expect(within(provenanceSection).getByText("C456")).toBeInTheDocument();
    expect(within(provenanceSection).getByText("1700000000.000100")).toBeInTheDocument();
  });

  it("renders an api source", () => {
    render(<RunInspector {...baseProps({ source: API_SOURCE })} />);

    const provenanceSection = section("Provenance");
    expect(
      within(provenanceSection).getByText("Source", { selector: "dt" }).nextElementSibling
        ?.textContent
    ).toBe("API");
    expect(within(provenanceSection).getByText("client-1")).toBeInTheDocument();
    expect(within(provenanceSection).getByText("delivery-3")).toBeInTheDocument();
  });

  it("renders untrusted source text as a plain text child, never parsed as markup", () => {
    const injected: SourceRef = SourceRefSchema.parse({
      kind: "github",
      repositoryFullName: "<script>evil()</script>",
      issueNumber: 1,
      deliveryId: "delivery-x"
    });

    const { container } = render(<RunInspector {...baseProps({ source: injected })} />);

    // The literal string appears as text content...
    expect(screen.getByText("<script>evil()</script>")).toBeInTheDocument();
    // ...and was never parsed into an actual <script> element.
    expect(container.querySelector("script")).toBeNull();
  });

  it("renders workflow version and adapter ID", () => {
    render(
      <RunInspector {...baseProps({ workflowVersion: "v9.9.9", adapterId: "codex.cloud.v2" })} />
    );

    const provenanceSection = section("Provenance");
    expect(within(provenanceSection).getByText("v9.9.9")).toBeInTheDocument();
    expect(within(provenanceSection).getByText("codex.cloud.v2")).toBeInTheDocument();
  });
});
