/**
 * Negotiate ACP capabilities into an honest descriptor and selection.
 *
 * The descriptor is derived from the `initialize` result and nothing else (D-9, D-12).
 * `permissions` is from the configured launch profile, not from an invented protocol
 * extension (D-12). An unparseable or absent result fails closed to the minimal descriptor.
 */

import { z } from "zod";

import type { AgentHarnessDescriptor } from "@autostack/contracts";

// ---- ACP protocol schemas (strict parse, fail closed) ----

const AcpAgentCapabilitiesSchema = z
  .object({
    loadSession: z.boolean(),
    promptCapabilities: z
      .object({
        image: z.boolean(),
        audio: z.boolean(),
        embeddedContext: z.boolean()
      })
      .passthrough(),
    mcpCapabilities: z.object({}).passthrough(),
    sessionCapabilities: z.object({}).passthrough(),
    auth: z.object({}).passthrough()
  })
  .passthrough();

const AcpAuthMethodSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional()
  })
  .passthrough();

const AcpInitializeResultSchema = z
  .object({
    protocolVersion: z.number(),
    agentInfo: z
      .object({
        name: z.string(),
        version: z.string()
      })
      .passthrough(),
    agentCapabilities: AcpAgentCapabilitiesSchema,
    authMethods: z.array(AcpAuthMethodSchema).default([])
  })
  .passthrough();

const AcpModeSchema = z
  .object({
    id: z.string(),
    name: z.string()
  })
  .passthrough();

const AcpConfigOptionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    category: z.string().optional(),
    currentValue: z.string().optional(),
    availableValues: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()).default([])
  })
  .passthrough();

const AcpSessionNewResultSchema = z
  .object({
    sessionId: z.string(),
    modes: z
      .object({
        currentModeId: z.string(),
        availableModes: z.array(AcpModeSchema)
      })
      .passthrough()
      .optional(),
    configOptions: z.array(AcpConfigOptionSchema).optional()
  })
  .passthrough();

export type AcpInitializeResult = z.infer<typeof AcpInitializeResultSchema>;
export type AcpSessionNewResult = z.infer<typeof AcpSessionNewResultSchema>;

export interface AcpNegotiationConfig {
  /** Whether the launch profile is configured with a permission responder (D-12). */
  readonly permissionsConfigured: boolean;
}

export interface AcpNegotiatedProfile {
  readonly descriptor: AgentHarnessDescriptor;
  readonly selection: {
    readonly modelSelection: boolean;
    readonly reasoningSelection: boolean;
    readonly permissionModes: readonly string[];
  };
}

const SCHEMA_VERSION = 1 as const;

/**
 * Negotiate ACP capabilities from the initialize and session/new results.
 *
 * Fails closed to the minimal descriptor on any parse failure.
 */
export const negotiateAcpCapabilities = (
  rawInitResult: AcpInitializeResult,
  rawSessionResult: AcpSessionNewResult,
  config: AcpNegotiationConfig
): AcpNegotiatedProfile => {
  const initParsed = AcpInitializeResultSchema.safeParse(rawInitResult);
  const sessionParsed = AcpSessionNewResultSchema.safeParse(rawSessionResult);

  if (!initParsed.success) {
    return buildMinimalProfile(config);
  }

  const init = initParsed.data;
  const session = sessionParsed.success ? sessionParsed.data : undefined;

  const hasLoadSession = init.agentCapabilities.loadSession;
  const hasPermissions = config.permissionsConfigured;
  const hasStructuredPlans = init.agentCapabilities.promptCapabilities.embeddedContext;

  // D-9: model and reasoning selection from session/new configOptions
  const configOptions = session?.configOptions ?? [];
  const hasModelSelection = configOptions.some(
    (opt) => opt.category === "model"
  );
  const hasReasoningSelection = configOptions.some(
    (opt) => opt.category === "reasoning"
  );

  // Permission modes from available modes (when permissions is configured)
  const permissionModes = hasPermissions && session?.modes
    ? session.modes.availableModes.map((m) => m.id)
    : [];

  const adapterId = hasLoadSession
    ? `acp/${init.agentInfo.name}/full`
    : `acp/${init.agentInfo.name}/minimal`;

  const descriptor: AgentHarnessDescriptor = {
    schemaVersion: SCHEMA_VERSION,
    adapterId,
    kind: "acp",
    displayName: init.agentInfo.name,
    capabilities: {
      resume: hasLoadSession,
      steering: true, // ACP always supports steering via session/prompt
      permissions: hasPermissions,
      structuredPlans: hasStructuredPlans
    }
  };

  return {
    descriptor,
    selection: {
      modelSelection: hasModelSelection,
      reasoningSelection: hasReasoningSelection,
      permissionModes
    }
  };
};

const buildMinimalProfile = (config: AcpNegotiationConfig): AcpNegotiatedProfile => ({
  descriptor: {
    schemaVersion: SCHEMA_VERSION,
    adapterId: "acp/unknown/minimal",
    kind: "acp",
    displayName: "ACP Agent",
    capabilities: {
      resume: false,
      steering: true,
      permissions: config.permissionsConfigured,
      structuredPlans: false
    }
  },
  selection: {
    modelSelection: false,
    reasoningSelection: false,
    permissionModes: []
  }
});
