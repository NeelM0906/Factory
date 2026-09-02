/**
 * Claude Code event mapper: pure functions from one Claude Code stream-json
 * frame to zero or more AgentSessionStreamEvent values.
 *
 * Every produced event goes through AgentSessionStreamEventSchema.parse before
 * it leaves. A parse failure becomes provider_output_malformed, keeping the
 * fail-closed rule from turning a bad frame into a thrown exception at the port.
 *
 * Redaction is per-field after JSON parse (D-4).
 *
 * Usage honesty:
 * - Per-message assistant usage has unknown reasoning and unknown cost
 *   (the provider does not report those per message).
 * - Result usage has reported cost when total_cost_usd is present,
 *   and reported reasoning when output_tokens_details.thinking_tokens is present.
 * - Unknown figures are { state: "unknown" }, never fabricated as zero.
 */

import {
  EventSequencer,
  sanitizeTextField,
  type AgentEvidenceSink
} from "@autostack/agent-adapter-kit";
import {
  classifyClaudeFailure,
  type ClaudeFailureInput
} from "./claude-failures.js";
import {
  classifyClaudeFrame,
  ClaudeSystemInitFrameSchema,
  ClaudeAssistantFrameSchema,
  ClaudeUserFrameSchema,
  ClaudeResultFrameSchema,
  ClaudePermissionRequestSchema,
  type ClaudeAssistantFrame,
  type ClaudeResultFrame,
  type ClaudePermissionRequest
} from "./claude-frames.js";
import {
  AgentSessionStreamEventSchema,
  type AgentSessionStreamEvent
} from "@autostack/contracts";

// ---- Public types ----

export interface ClaudeMapperContext {
  readonly sessionId: string;
  readonly providerSessionId: string;
  readonly sequencer: EventSequencer;
  readonly evidenceSink: AgentEvidenceSink;
  readonly workspaceCwd: string;
  readonly structuredPlans: boolean;
}

// ---- Internal helpers ----

const SCHEMA_VERSION = 1 as const;

const now = (): string => new Date().toISOString();

const buildContext = (ctx: ClaudeMapperContext) => ({
  schemaVersion: SCHEMA_VERSION,
  sessionId: ctx.sessionId,
  sequence: ctx.sequencer.next(),
  occurredAt: now()
});

/**
 * Safely parse and emit an event. If the event fails schema validation,
 * returns a failed event with provider_output_malformed.
 */
const safeEmit = (
  rawEvent: Record<string, unknown>,
  ctx: ClaudeMapperContext
): AgentSessionStreamEvent => {
  const parsed = AgentSessionStreamEventSchema.safeParse(rawEvent);
  if (parsed.success) {
    return parsed.data;
  }
  const failedContext = {
    schemaVersion: SCHEMA_VERSION,
    sessionId: ctx.sessionId,
    sequence: ctx.sequencer.next(),
    occurredAt: now()
  };
  ctx.sequencer.markTerminal();
  return AgentSessionStreamEventSchema.parse({
    ...failedContext,
    type: "failed",
    code: "provider_output_malformed",
    message: "Claude frame could not be mapped to a valid event.",
    retryable: false
  });
};

// ---- Usage builders ----

/** Per-message usage: input/output/cache reported, reasoning unknown, cost unknown. */
const buildPerMessageUsage = (usage: Record<string, unknown>) => ({
  tokens: {
    input: typeof usage.input_tokens === "number"
      ? { state: "reported" as const, value: usage.input_tokens }
      : { state: "unknown" as const },
    output: typeof usage.output_tokens === "number"
      ? { state: "reported" as const, value: usage.output_tokens }
      : { state: "unknown" as const },
    cachedInput: typeof usage.cache_read_input_tokens === "number"
      ? { state: "reported" as const, value: usage.cache_read_input_tokens }
      : { state: "unknown" as const },
    reasoning: { state: "unknown" as const }
  },
  cost: { state: "unknown" as const }
});

/** Result usage: all figures reported if present. */
const buildResultUsage = (resultFrame: ClaudeResultFrame) => {
  const usage = resultFrame.usage;

  const tokens = {
    input: typeof usage?.input_tokens === "number"
      ? { state: "reported" as const, value: usage.input_tokens }
      : { state: "unknown" as const },
    output: typeof usage?.output_tokens === "number"
      ? { state: "reported" as const, value: usage.output_tokens }
      : { state: "unknown" as const },
    cachedInput: typeof usage?.cache_read_input_tokens === "number"
      ? { state: "reported" as const, value: usage.cache_read_input_tokens }
      : { state: "unknown" as const },
    reasoning: typeof usage?.output_tokens_details?.thinking_tokens === "number"
      ? { state: "reported" as const, value: usage.output_tokens_details.thinking_tokens }
      : { state: "unknown" as const }
  };

  const cost = typeof resultFrame.total_cost_usd === "number"
    ? {
        state: "reported" as const,
        currency: "USD" as const,
        micros: Math.round(resultFrame.total_cost_usd * 1_000_000)
      }
    : { state: "unknown" as const };

  return { tokens, cost };
};

// ---- Main mapper ----

/**
 * Map one Claude Code stream-json frame to zero or more normalized events.
 */
export const mapClaudeFrame = async (
  frame: Record<string, unknown>,
  ctx: ClaudeMapperContext
): Promise<AgentSessionStreamEvent[]> => {
  const classification = classifyClaudeFrame(frame);

  switch (classification) {
    case "system/init":
      return mapSystemInit(frame, ctx);

    case "assistant":
      return mapAssistant(frame, ctx);

    case "user":
      return mapUser(frame, ctx);

    case "result":
      return await mapResult(frame, ctx);

    case "permission_request":
      return await mapPermissionRequest(frame, ctx);

    // Dropped frame types
    case "rate_limit_event":
    case "system/task_summary":
    case "system/post_turn_summary":
      return [];

    default:
      // Unknown frame type — drop
      return [];
  }
};

// ---- system/init -> started ----

const mapSystemInit = (
  frame: Record<string, unknown>,
  ctx: ClaudeMapperContext
): AgentSessionStreamEvent[] => {
  const parsed = ClaudeSystemInitFrameSchema.safeParse(frame);
  if (!parsed.success) return [];

  return [
    safeEmit(
      {
        ...buildContext(ctx),
        type: "started",
        providerSessionRef: ctx.providerSessionId
      },
      ctx
    )
  ];
};

// ---- assistant -> message + tool_call ----

const mapAssistant = (
  frame: Record<string, unknown>,
  ctx: ClaudeMapperContext
): AgentSessionStreamEvent[] => {
  const parsed = ClaudeAssistantFrameSchema.safeParse(frame);
  if (!parsed.success) return [];

  const events: AgentSessionStreamEvent[] = [];
  const assistantFrame: ClaudeAssistantFrame = parsed.data;
  const content = assistantFrame.message.content;

  for (const block of content) {
    const blockType = (block as Record<string, unknown>).type as string | undefined;

    if (blockType === "text") {
      const textBlock = block as { type: "text"; text: string };
      const text = sanitizeTextField(textBlock.text);
      if (text != null) {
        events.push(
          safeEmit(
            { ...buildContext(ctx), type: "message", role: "assistant", text },
            ctx
          )
        );
      }
    } else if (blockType === "tool_use") {
      const toolBlock = block as { type: "tool_use"; id: string; name: string; input?: Record<string, unknown> };
      const name = sanitizeTextField(toolBlock.name, { maxBytes: 200 }) ?? "unknown";
      events.push(
        safeEmit(
          {
            ...buildContext(ctx),
            type: "tool_call",
            toolCallRef: toolBlock.id,
            name,
            phase: "started"
          },
          ctx
        )
      );
    }
    // thinking blocks and other block types are dropped
  }

  // Emit per-message usage if present
  if (assistantFrame.message.usage != null) {
    const usage = buildPerMessageUsage(
      assistantFrame.message.usage as unknown as Record<string, unknown>
    );
    events.push(
      safeEmit(
        {
          ...buildContext(ctx),
          type: "usage",
          ...usage
        },
        ctx
      )
    );
  }

  return events;
};

// ---- user -> tool_call completed/failed ----

const mapUser = (
  frame: Record<string, unknown>,
  ctx: ClaudeMapperContext
): AgentSessionStreamEvent[] => {
  const parsed = ClaudeUserFrameSchema.safeParse(frame);
  if (!parsed.success) return [];

  const events: AgentSessionStreamEvent[] = [];
  const content = parsed.data.message.content;

  for (const block of content) {
    const blockRecord = block as Record<string, unknown>;
    if (blockRecord.type === "tool_result") {
      const toolUseId = blockRecord.tool_use_id as string | undefined;
      if (toolUseId != null) {
        const isError = blockRecord.is_error === true;
        const phase = isError ? "failed" : "completed";
        events.push(
          safeEmit(
            {
              ...buildContext(ctx),
              type: "tool_call",
              toolCallRef: toolUseId,
              name: toolUseId, // tool_result doesn't repeat the tool name
              phase
            },
            ctx
          )
        );
      }
    }
  }

  return events;
};

// ---- result -> completed/failed + usage ----

const mapResult = async (
  frame: Record<string, unknown>,
  ctx: ClaudeMapperContext
): Promise<AgentSessionStreamEvent[]> => {
  const parsed = ClaudeResultFrameSchema.safeParse(frame);
  if (!parsed.success) return [];

  const resultFrame = parsed.data;
  const events: AgentSessionStreamEvent[] = [];

  // Emit result-level usage first (before any terminal)
  const resultUsage = buildResultUsage(resultFrame);
  events.push(
    safeEmit(
      {
        ...buildContext(ctx),
        type: "usage",
        ...resultUsage
      },
      ctx
    )
  );

  if (resultFrame.is_error) {
    // Failed session
    const failureInput: ClaudeFailureInput = {
      kind: "result_error",
      subtype: resultFrame.subtype,
      isError: true
    };
    const classified = classifyClaudeFailure(failureInput);
    const message = sanitizeTextField(
      typeof resultFrame.result === "string"
        ? resultFrame.result
        : `Claude session failed: ${resultFrame.subtype}`,
      { maxBytes: 2_000 }
    ) ?? `Claude session failed: ${resultFrame.subtype}`;

    const failedCtx = buildContext(ctx);
    ctx.sequencer.markTerminal();

    events.push(
      safeEmit(
        {
          ...failedCtx,
          type: "failed",
          code: classified.code,
          message,
          retryable: classified.retryable ?? false
        },
        ctx
      )
    );
  } else {
    // Successful turn completion — record transcript evidence
    const transcriptBytes = Buffer.from(
      JSON.stringify({
        subtype: resultFrame.subtype,
        stopReason: resultFrame.stop_reason,
        completedAt: now()
      }),
      "utf8"
    );
    const { digest } = await ctx.evidenceSink.record({
      kind: "transcript",
      bytes: new Uint8Array(transcriptBytes)
    });

    const completedCtx = buildContext(ctx);
    ctx.sequencer.markTerminal();

    events.push(
      safeEmit(
        {
          ...completedCtx,
          type: "completed",
          evidenceDigests: [digest]
        },
        ctx
      )
    );
  }

  return events;
};

// ---- JSON-RPC permission request -> permission_requested ----

const mapPermissionRequest = async (
  frame: Record<string, unknown>,
  ctx: ClaudeMapperContext
): Promise<AgentSessionStreamEvent[]> => {
  const parsed = ClaudePermissionRequestSchema.safeParse(frame);
  if (!parsed.success) return [];

  const permRequest: ClaudePermissionRequest = parsed.data;
  const toolUseId = permRequest.params.arguments.tool_use_id;
  const toolName = permRequest.params.arguments.tool_name;
  const input = permRequest.params.arguments.input;

  // Record permission evidence
  const permBytes = Buffer.from(
    JSON.stringify({
      toolUseId,
      toolName,
      input,
      rpcId: permRequest.id
    }),
    "utf8"
  );
  const { digest } = await ctx.evidenceSink.record({
    kind: "permission",
    bytes: new Uint8Array(permBytes)
  });

  const summary = sanitizeTextField(
    `Permission required: ${toolName} (${toolUseId})`,
    { maxBytes: 2_000 }
  ) ?? "Permission required";

  return [
    safeEmit(
      {
        ...buildContext(ctx),
        type: "permission_requested",
        permissionRef: toolUseId,
        summary,
        evidenceDigest: digest
      },
      ctx
    )
  ];
};
