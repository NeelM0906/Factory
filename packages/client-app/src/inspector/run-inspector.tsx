import { InspectorSection, type InspectorRow } from "@autostack/ui";

import type {
  AgentHarnessProfile,
  Environment,
  ModelPolicy,
  ModelRouteFallback,
  ModelRouteSelection,
  ModelUsageRecord,
  SourceRef
} from "@autostack/contracts";

import { deriveUsageSummary, formatCostMicros } from "./usage-summary.js";

/**
 * Props for the right inspector (spec §4.1): harness, model route, environment, usage, policy, and
 * provenance for one stage run. Every field is read-only display data — see the SECURITY PIN in
 * the Task 6 brief: editing a harness/adapter/launch/policy value is equivalent to permission to
 * execute local code (spec §9.3), so this component has no edit affordance and no mutation callback
 * prop anywhere. If a future change wants one, that is a new authorization decision, not a UI gap.
 *
 * `routeFallback`, `environment`, and `usage` are required-but-`| undefined` (not `?:`) to match
 * `exactOptionalPropertyTypes` and the existing pane convention (`VerificationPaneProps.report`):
 * an optional `?:` field cannot be explicitly assigned `undefined` under that flag, and callers here
 * need to say "explicitly none" rather than merely omit the prop. Their data may legitimately not
 * exist yet: no fallback ever occurred, no environment has been provisioned pre-execution (contracts
 * already model this — `AgentInvocationRequestSchema.environmentId` is optional for the same
 * reason), and no usage has been recorded yet. Each renders a named state rather than a blank
 * section body or invented data.
 */
export interface RunInspectorProps {
  readonly harness: AgentHarnessProfile;
  readonly routeSelection: ModelRouteSelection;
  readonly routeFallback: ModelRouteFallback | undefined;
  readonly environment: Environment | undefined;
  readonly usage: ModelUsageRecord | undefined;
  readonly policy: ModelPolicy;
  readonly source: SourceRef;
  readonly workflowVersion: string;
  readonly adapterId: string;
}

/**
 * Builds one `InspectorRow`, omitting the `value` key entirely when `value` is `undefined` —
 * required because `InspectorRow.value?: string | number` does not admit an explicit `undefined`
 * under `exactOptionalPropertyTypes`. `InspectorSection` treats "key omitted" and "key present with
 * `undefined`" identically at runtime (both are `=== undefined`); this only satisfies the type.
 */
function row(term: string, value: string | number | undefined): InspectorRow {
  return value === undefined ? { term } : { term, value };
}

const HARNESS_CAPABILITIES: ReadonlyArray<{
  readonly key: keyof AgentHarnessProfile["descriptor"]["capabilities"];
  readonly label: string;
}> = [
  { key: "resume", label: "Resume" },
  { key: "steering", label: "Steering" },
  { key: "permissions", label: "Permissions" },
  { key: "structuredPlans", label: "Structured plans" }
];

/**
 * A capability the adapter does not declare renders as a row reading "Unavailable" — the row is
 * always present (spec §9.1: "unsupported capabilities remain visibly unavailable"), never omitted.
 * Installed/authenticated status are separate rows from capability rows, per the same section.
 */
function harnessRows(harness: AgentHarnessProfile): readonly InspectorRow[] {
  const { capabilities } = harness.descriptor;
  const capabilityRows: readonly InspectorRow[] = HARNESS_CAPABILITIES.map((capability) =>
    row(capability.label, capabilities[capability.key] ? "Available" : "Unavailable")
  );
  return [
    row("Adapter", harness.descriptor.displayName),
    row("Kind", harness.descriptor.kind),
    ...capabilityRows,
    row("Installed", harness.availability.installed ? "Yes" : "No"),
    row("Authenticated", harness.availability.authenticated ? "Yes" : "No")
  ];
}

/**
 * A fallback's rows only exist in the array when a fallback actually occurred (`fallback !==
 * undefined`) — no fallback means those rows are entirely absent from the DOM, not present with a
 * fabricated "Not recorded" value. `failureCode` renders the raw value from the closed
 * `MODEL_ROUTING_FAILURE_CODES` taxonomy (audit item 21).
 */
function modelRouteRows(
  selection: ModelRouteSelection,
  fallback: ModelRouteFallback | undefined
): readonly InspectorRow[] {
  const selectionRows: readonly InspectorRow[] = [
    row("Route", selection.routeRef),
    row("Selection reason", selection.reason),
    row("Selected at", selection.selectedAt)
  ];
  const fallbackRows: readonly InspectorRow[] =
    fallback === undefined
      ? []
      : [
          row("Fallback from", `${fallback.from.routeRef} (${fallback.from.model})`),
          row("Fallback to", `${fallback.to.routeRef} (${fallback.to.model})`),
          row("Failure code", fallback.failureCode),
          row("Fallback reason", fallback.reason)
        ];
  return [...selectionRows, ...fallbackRows];
}

/** No environment provisioned yet renders one named-state row rather than a blank section body. */
function environmentRows(environment: Environment | undefined): readonly InspectorRow[] {
  if (environment === undefined) {
    return [row("Environment", "Not yet provisioned")];
  }
  return [
    row("Branch", environment.branch),
    row("Base commit", environment.sourceCommit),
    row("Network policy", environment.networkPolicy),
    row("CPU limit (vCPU)", environment.resourceLimits.cpu),
    row("Memory limit (MB)", environment.resourceLimits.memoryMb),
    row("Duration limit (s)", environment.resourceLimits.durationSeconds)
  ];
}

/**
 * No usage record yet renders one named-state row. Otherwise every field comes straight from
 * `deriveUsageSummary` — `number | undefined` and `string | undefined` pass through `row()`, so an
 * unreported token count or cost renders "Not recorded" via `InspectorSection` itself (spec §10.2),
 * with no re-derivation here.
 */
function usageRows(usage: ModelUsageRecord | undefined): readonly InspectorRow[] {
  if (usage === undefined) {
    return [row("Usage", "No usage recorded yet")];
  }
  const summary = deriveUsageSummary(usage);
  return [
    row("Input tokens", summary.inputTokens),
    row("Output tokens", summary.outputTokens),
    row("Cached input tokens", summary.cachedInputTokens),
    row("Reasoning tokens", summary.reasoningTokens),
    row("Cost", summary.cost)
  ];
}

/**
 * Allowed/fallback routes render in the policy's own authored order — never sorted, per the Task
 * 5b findings-ruling convention that a report's own ordering is the source of truth. An empty
 * fallback list is a real, present fact (`fallbackRouteRefs` is a required array, not optional), so
 * it renders the literal "None" rather than "Not recorded", which is reserved for genuinely unknown
 * data. Read-only: no ceiling or route here is ever editable (SECURITY PIN, spec §9.3).
 */
function policyRows(policy: ModelPolicy): readonly InspectorRow[] {
  return [
    row("Allowed routes", policy.allowedRouteRefs.join(", ")),
    row(
      "Fallback routes",
      policy.fallbackRouteRefs.length > 0 ? policy.fallbackRouteRefs.join(", ") : "None"
    ),
    row("Max input tokens", policy.maxInputTokens),
    row("Max output tokens", policy.maxOutputTokens),
    row(
      "Max cost",
      policy.maxCostMicros === undefined ? undefined : formatCostMicros(policy.maxCostMicros)
    ),
    row("Reasoning level", policy.reasoningLevel)
  ];
}

/** Renders `SourceRef` per its kind. Every value passes through `row()`, so it always reaches the
 * DOM as a text child (`InspectorSection` never injects markup) — untrusted provenance text can
 * never become an element. */
function sourceRows(source: SourceRef): readonly InspectorRow[] {
  switch (source.kind) {
    case "manual":
      return [row("Source", "Manual"), row("Client", source.client)];
    case "github":
      return [
        row("Source", "GitHub"),
        row("Repository", source.repositoryFullName),
        row("Issue number", source.issueNumber),
        row("Delivery ID", source.deliveryId),
        row("URL", source.url)
      ];
    case "slack":
      return [
        row("Source", "Slack"),
        row("Slack workspace ID", source.slackWorkspaceId),
        row("Channel ID", source.channelId),
        row("Thread", source.threadTs),
        row("Delivery ID", source.deliveryId)
      ];
    case "api":
      return [
        row("Source", "API"),
        row("Client ID", source.clientId),
        row("Delivery ID", source.deliveryId)
      ];
  }
}

function provenanceRows(
  source: SourceRef,
  workflowVersion: string,
  adapterId: string
): readonly InspectorRow[] {
  return [
    ...sourceRows(source),
    row("Workflow version", workflowVersion),
    row("Adapter ID", adapterId)
  ];
}

/**
 * The right inspector (spec §4.1): six labelled, read-only sections stacked in one panel, each
 * built on `InspectorSection` (Task 4a, `@autostack/ui`). Pure presentational — no fetching, no
 * mutation, no callback props (SECURITY PIN, spec §9.3).
 */
export function RunInspector(props: RunInspectorProps) {
  return (
    <div className="run-inspector">
      <InspectorSection title="Harness" rows={harnessRows(props.harness)} />
      <InspectorSection
        title="Model route"
        rows={modelRouteRows(props.routeSelection, props.routeFallback)}
      />
      <InspectorSection title="Environment" rows={environmentRows(props.environment)} />
      <InspectorSection title="Usage" rows={usageRows(props.usage)} />
      <InspectorSection title="Policy" rows={policyRows(props.policy)} />
      <InspectorSection
        title="Provenance"
        rows={provenanceRows(props.source, props.workflowVersion, props.adapterId)}
      />
    </div>
  );
}
