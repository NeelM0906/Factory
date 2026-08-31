import {
  AgentHarnessDescriptorSchema,
  PlanDocumentSchema,
  ReviewReportSchema,
  TriageReportSchema,
  type AgentHarnessDescriptor,
  type AgentInvocationRequest,
  type ModelInferencePort,
  type ModelRouteContext,
  type ModelRouterPort
} from "@autostack/contracts";
import type { z } from "zod";

import type { NativeContextReader } from "./context-assembly.js";
import { isPathInScope, type ContextScope } from "./context-scope.js";
import { NATIVE_PROMPTS, type NativeAgentRole } from "./prompts/index.js";
import { pickModelAuthoredShape } from "./prompts/prompt-artifact.js";
import type { StructuredOutputPolicy } from "./structured-output.js";

/** One upstream document handed to a role for a single invocation. */
export interface NativeRoleInput {
  readonly label: string;
  readonly content: string;
}

/**
 * Per-invocation upstream documents (review finding 2b); an I1 composition interface. The method
 * is named `forInvocation` — the name this stream published to I1 — and T10 widens the returned
 * inputs to the roles' typed documents.
 */
export interface NativeRoleInputsProvider {
  forInvocation(request: AgentInvocationRequest): Promise<readonly NativeRoleInput[]>;
}

/** The context sources a role configuration declares; everything else is out of scope. */
export interface NativeContextConfig {
  readonly paths: readonly string[];
  readonly scope: ContextScope;
  readonly limits: { readonly maxFiles: number; readonly maxBytes: number };
}

export interface NativeSessionConfig {
  readonly resumable: boolean;
  /** Whether the port accepts `steer` at all — the capability bit the descriptor declares. */
  readonly steerable: boolean;
  /**
   * Whether the session BLOCKS for an operator instruction after context assembly and before
   * the model call (the plan's interactive mode). Distinct from `steerable`, because a
   * steering-capable session must still be able to run unattended: a steer that arrives before
   * the model call is folded in either way, but only an interactive session waits for one.
   * Requires `steerable`; refused at construction otherwise.
   */
  readonly interactive: boolean;
}

export interface NativeHarnessConfig {
  readonly adapterId: string;
  readonly role: NativeAgentRole;
  readonly session: NativeSessionConfig;
  readonly permissioned: boolean;
  readonly context: NativeContextConfig;
}

export interface NativeHarnessDeps {
  readonly router: ModelRouterPort;
  readonly inference: ModelInferencePort;
  readonly reader: NativeContextReader;
  readonly roleInputs: NativeRoleInputsProvider;
  readonly now: () => string;
  readonly newProviderSessionRef: () => string;
  /** Injected stable-ref factory minting toolCallRefs and permissionRefs; no ambient randomness. */
  readonly newRef: () => string;
  readonly structuredOutput: StructuredOutputPolicy;
  /** Resolves when the host is lost; the session then ends in `interrupted` (spec §15). */
  readonly hostLoss?: Promise<void>;
}

/** The station stage each native role bills its model routing under. */
export const ROLE_STAGES: Readonly<Record<NativeAgentRole, ModelRouteContext["stage"]>> =
  Object.freeze({
    triage: "triage",
    plan: "plan",
    review: "isolated_review"
  });

/** Interim per-role output ceilings; T8's role configuration formalizes these. */
export const ROLE_MAX_OUTPUT_TOKENS: Readonly<Record<NativeAgentRole, number>> = Object.freeze({
  triage: 8_192,
  plan: 32_768,
  review: 16_384
});

/**
 * The model-authored subset of each role's output document schema — exactly the shape the role's
 * prompt asked for, derived from the same declaration so admission and prompt cannot drift.
 */
export const ROLE_OUTPUT_SCHEMAS: Readonly<Record<NativeAgentRole, z.ZodType>> = Object.freeze({
  triage: pickModelAuthoredShape(
    TriageReportSchema.shape,
    NATIVE_PROMPTS.triage.modelAuthoredFields
  ),
  plan: pickModelAuthoredShape(PlanDocumentSchema.shape, NATIVE_PROMPTS.plan.modelAuthoredFields),
  review: pickModelAuthoredShape(
    ReviewReportSchema.shape,
    NATIVE_PROMPTS.review.modelAuthoredFields
  )
});

/**
 * The descriptor is DERIVED from the configuration, never handed in, so a capability bit can only
 * disagree with the port surface by a defect here — which the conformance suite pins.
 */
export const deriveNativeDescriptor = (config: NativeHarnessConfig): AgentHarnessDescriptor =>
  AgentHarnessDescriptorSchema.parse({
    schemaVersion: 1,
    adapterId: config.adapterId,
    kind: "native",
    displayName: `AutoStack native ${config.role} harness`,
    capabilities: {
      resume: config.session.resumable,
      steering: config.session.steerable,
      permissions: config.permissioned,
      structuredPlans: config.role === "plan"
    }
  });

/**
 * An unpermissioned configuration must not declare an out-of-scope context source at all: with no
 * permission surface, such a read could only ever be denied, so declaring one is a configuration
 * defect refused at construction — mirroring the reference fake's construction-time refusal.
 */
/** An interactive wait is released only by a steer, so it cannot exist without steering. */
export const assertSessionConfigCoherent = (config: NativeHarnessConfig): void => {
  if (config.session.interactive && !config.session.steerable) {
    throw new TypeError("An unsteerable native harness cannot run an interactive session.");
  }
};

export const assertContextSourcesPermissible = (config: NativeHarnessConfig): void => {
  if (config.permissioned) {
    return;
  }
  const outOfScope = config.context.paths.filter(
    (path) => !isPathInScope(config.context.scope, path)
  );
  if (outOfScope.length > 0) {
    throw new TypeError(
      "An unpermissioned native harness cannot declare out-of-scope context sources."
    );
  }
};
