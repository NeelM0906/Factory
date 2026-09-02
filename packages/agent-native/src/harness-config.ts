import {
  AgentHarnessDescriptorSchema,
  type AgentHarnessDescriptor,
  type AgentInvocationRequest,
  type ModelInferencePort,
  type ModelRouterPort
} from "@autostack/contracts";

import type { NativeContextReader } from "./context-assembly.js";
import { isPathInScope, type ContextScope } from "./context-scope.js";
import type { NativeAgentRole } from "./prompts/index.js";
import type { NativeRoleInputs } from "./roles/role-inputs.js";
import type { StructuredOutputPolicy } from "./structured-output.js";

export type {
  NativeRoleInput,
  NativeRoleInputs,
  ReviewRoleDocuments,
  ReviewedDiffDescriptor
} from "./roles/role-inputs.js";

/**
 * Per-invocation upstream documents (review finding 2b); an I1 composition interface. The method
 * is named `forInvocation` — the name this stream published to I1 — and T10 widened the returned
 * inputs to `NativeRoleInputs`: plain `{label, content}` entries for triage and plan, the typed
 * `ReviewRoleDocuments` for the reviewer.
 */
export interface NativeRoleInputsProvider {
  forInvocation(request: AgentInvocationRequest): Promise<NativeRoleInputs>;
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
