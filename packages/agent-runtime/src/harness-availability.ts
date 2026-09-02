import {
  AgentHarnessProfileSchema,
  SafeMetadataStringSchema,
  redactSensitiveText,
  type AgentHarnessDescriptor,
  type AgentHarnessProfile
} from "@autostack/contracts";

import { AGENT_RUNTIME_FAILURES } from "./errors.js";

/** What an availability probe reports about a harness, before any validation. */
export interface AgentHarnessAvailabilityFacts {
  readonly installed: boolean;
  readonly authenticated: boolean;
  readonly detail?: string;
}

/**
 * The probe budget is injected as a factory whose promise resolves when the budget elapses. The
 * availability layer only races against it — it owns no timers, so callers (and tests) decide what
 * "the budget elapsed" means without any real sleeping here.
 */
export interface DescribeHarnessAvailabilityOptions {
  readonly descriptor: AgentHarnessDescriptor;
  readonly selection: AgentHarnessProfile["selection"];
  readonly probe: () => Promise<AgentHarnessAvailabilityFacts>;
  readonly now: () => string;
  readonly probeTimeout: () => Promise<void>;
}

/**
 * The failure table is the single source of the probe-failure wording; every fail-closed detail is
 * composed from it plus redacted specifics.
 */
const PROBE_FAILURE_MESSAGE = AGENT_RUNTIME_FAILURES.agent_harness_probe_failed.message;

const DETAIL_LIMIT = 2_000;
const DetailSchema = SafeMetadataStringSchema.max(DETAIL_LIMIT);

/**
 * Bounds a detail to the profile schema's limit and falls back to the bare table message when the
 * candidate would not survive `SafeMetadataStringSchema` (e.g. truncation left a suspicious tail).
 */
const boundedDetail = (candidate: string): string => {
  const bounded = candidate.length > DETAIL_LIMIT ? candidate.slice(0, DETAIL_LIMIT) : candidate;
  return DetailSchema.safeParse(bounded).success ? bounded : PROBE_FAILURE_MESSAGE;
};

const failedClosed = (detail: string): AgentHarnessAvailabilityFacts => ({
  installed: false,
  authenticated: false,
  detail: boundedDetail(detail)
});

type ProbeOutcome =
  | { readonly kind: "reported"; readonly facts: AgentHarnessAvailabilityFacts }
  | { readonly kind: "threw"; readonly error: unknown }
  | { readonly kind: "timed_out" };

const raceProbe = (options: DescribeHarnessAvailabilityOptions): Promise<ProbeOutcome> =>
  Promise.race<ProbeOutcome>([
    // Funnel a synchronously-throwing probe into the same fail-closed path as a rejection.
    Promise.resolve()
      .then(() => options.probe())
      .then(
        (facts): ProbeOutcome => ({ kind: "reported", facts }),
        (error: unknown): ProbeOutcome => ({ kind: "threw", error })
      ),
    // A budget that rejects is treated as elapsed: fail closed, never throw.
    options.probeTimeout().then(
      (): ProbeOutcome => ({ kind: "timed_out" }),
      (): ProbeOutcome => ({ kind: "timed_out" })
    )
  ]);

const redactedErrorText = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(text);
};

const normalizeOutcome = (outcome: ProbeOutcome): AgentHarnessAvailabilityFacts => {
  if (outcome.kind === "timed_out") {
    return failedClosed(`${PROBE_FAILURE_MESSAGE} The probe timed out before reporting.`);
  }
  if (outcome.kind === "threw") {
    const specifics = redactedErrorText(outcome.error);
    return failedClosed(
      specifics.length === 0 ? PROBE_FAILURE_MESSAGE : `${PROBE_FAILURE_MESSAGE} ${specifics}`
    );
  }
  const { facts } = outcome;
  if (facts.authenticated && !facts.installed) {
    return failedClosed(
      `${PROBE_FAILURE_MESSAGE} The probe reported authenticated while not installed; ` +
        "the harness is treated as neither installed nor authenticated."
    );
  }
  if (facts.detail === undefined) {
    return { installed: facts.installed, authenticated: facts.authenticated };
  }
  const detail = redactSensitiveText(facts.detail);
  return {
    installed: facts.installed,
    authenticated: facts.authenticated,
    ...(detail.length === 0 ? {} : { detail: boundedDetail(detail) })
  };
};

/**
 * Turns a probe's raw facts into a schema-valid `AgentHarnessProfile`, failing closed: a timeout,
 * a thrown probe, or contradictory facts all become `{ installed: false, authenticated: false }`
 * with an explanatory (redacted) detail — never an exception that would let one lying adapter
 * brick the whole listing.
 */
export const describeHarnessAvailability = async (
  options: DescribeHarnessAvailabilityOptions
): Promise<AgentHarnessProfile> => {
  const facts = normalizeOutcome(await raceProbe(options));
  return AgentHarnessProfileSchema.parse({
    schemaVersion: 1,
    descriptor: options.descriptor,
    selection: {
      modelSelection: options.selection.modelSelection,
      reasoningSelection: options.selection.reasoningSelection,
      // The schema refuses modes without the capability; this layer cannot construct that shape.
      permissionModes: options.descriptor.capabilities.permissions
        ? options.selection.permissionModes
        : []
    },
    availability: {
      installed: facts.installed,
      authenticated: facts.authenticated,
      ...(facts.detail === undefined ? {} : { detail: facts.detail }),
      checkedAt: options.now()
    }
  });
};
