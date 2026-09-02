/**
 * ACP event mapper: pure functions from one ACP provider frame to zero or more
 * AgentSessionStreamEvent values.
 *
 * Every produced event goes through AgentSessionStreamEventSchema.parse before
 * it leaves. A parse failure becomes provider_output_malformed, keeping the
 * fail-closed rule from turning a bad frame into a thrown exception at the port.
 *
 * Redaction is per-field after JSON parse (D-4).
 * Paths are relativized against the invocation cwd and validated; paths outside
 * the workspace become output events, never file_change (spec §14.1).
 * Usage is honestly unknown — ACP reports no figures (finding 15).
 */

import { relative, resolve } from "node:path";

import {
  EventSequencer,
  sanitizeTextField,
  type AgentEvidenceSink
} from "@autostack/agent-adapter-kit";
import { classifyAcpFailure } from "./acp-failures.js";
import {
  AgentSessionStreamEventSchema,
  type AgentSessionStreamEvent
} from "@autostack/contracts";

// ---- Public types ----

export interface AcpMapperContext {
  readonly sessionId: string;
  readonly sequencer: EventSequencer;
  readonly evidenceSink: AgentEvidenceSink;
  readonly workspaceCwd: string;
  readonly structuredPlans: boolean;
}

// ---- Usage builder (finding 15: all unknown, never zero) ----

export const buildUnknownUsage = () => ({
  tokens: {
    input: { state: "unknown" as const },
    output: { state: "unknown" as const },
    cachedInput: { state: "unknown" as const },
    reasoning: { state: "unknown" as const }
  },
  cost: { state: "unknown" as const }
});

// ---- Internal helpers ----

const SCHEMA_VERSION = 1 as const;

const now = (): string => new Date().toISOString();

const buildContext = (ctx: AcpMapperContext) => ({
  schemaVersion: SCHEMA_VERSION,
  sessionId: ctx.sessionId,
  sequence: ctx.sequencer.next(),
  occurredAt: now()
});

/**
 * Relativize an absolute path against the workspace cwd.
 * Returns undefined if the path escapes the workspace.
 */
const relativizePath = (
  absolutePath: string,
  workspaceCwd: string
): string | undefined => {
  const resolved = resolve(absolutePath);
  const resolvedCwd = resolve(workspaceCwd);

  // Must be under the workspace
  if (!resolved.startsWith(resolvedCwd + "/") && resolved !== resolvedCwd) {
    return undefined;
  }

  const rel = relative(resolvedCwd, resolved);

  // Reject traversals
  if (rel.startsWith("..") || rel.startsWith("/") || rel.includes("\\")) {
    return undefined;
  }

  return rel;
};

/**
 * Determine file change type from oldText/newText.
 */
const classifyChange = (
  oldText: string | null | undefined,
  newText: string | null | undefined
): "added" | "modified" | "deleted" => {
  if (oldText == null && newText != null) return "added";
  if (oldText != null && newText == null) return "deleted";
  return "modified";
};

/**
 * Safely parse and emit an event. If the event fails schema validation,
 * returns a failed event with provider_output_malformed.
 *
 * The sequence for the failed event must be allocated BEFORE markTerminal,
 * since the sequencer refuses allocation after a terminal.
 */
const safeEmit = (
  rawEvent: Record<string, unknown>,
  ctx: AcpMapperContext
): AgentSessionStreamEvent => {
  const parsed = AgentSessionStreamEventSchema.safeParse(rawEvent);
  if (parsed.success) {
    return parsed.data;
  }
  // Classified failure, not a crash.
  // Allocate the failed event's context first, then mark terminal.
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
    message: "ACP frame could not be mapped to a valid event.",
    retryable: false
  });
};

// ---- Main mapper ----

/**
 * Map one ACP frame to zero or more normalized events.
 *
 * The frame can be:
 * - A JSON-RPC notification (session/update, session/request_permission)
 * - A JSON-RPC response (result or error)
 * - A stderr line (kind: "stderr")
 */
export const mapAcpFrame = async (
  frame: Record<string, unknown>,
  ctx: AcpMapperContext
): Promise<AgentSessionStreamEvent[]> => {
  // Handle stderr frames
  if (frame.kind === "stderr") {
    const text = sanitizeTextField(String(frame.text ?? ""));
    if (text == null) return [];
    return [
      safeEmit(
        { ...buildContext(ctx), type: "output", stream: "stderr", text },
        ctx
      )
    ];
  }

  // JSON-RPC error response → failed
  if (frame.error != null && typeof frame.error === "object") {
    const error = frame.error as { code?: number; message?: string };
    const classified = classifyAcpFailure({
      kind: "jsonrpc_error",
      error: { code: error.code ?? 0, message: error.message ?? "" }
    });
    const message = sanitizeTextField(error.message ?? "Unknown error") ?? "Unknown error";
    // Allocate sequence before marking terminal
    const failedCtx = buildContext(ctx);
    ctx.sequencer.markTerminal();
    return [
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
    ];
  }

  // JSON-RPC result response (e.g., stopReason: end_turn)
  if (frame.result != null && typeof frame.result === "object") {
    const result = frame.result as { stopReason?: string };
    if (result.stopReason != null) {
      return await mapStopReason(result.stopReason, ctx);
    }
    // Other results (initialize, session/new, session/load results) are consumed
    // by the harness, not by the mapper
    return [];
  }

  // JSON-RPC notification
  const method = frame.method as string | undefined;
  if (method == null) return [];

  if (method === "session/update") {
    return await mapSessionUpdate(frame, ctx);
  }

  if (method === "session/request_permission") {
    return await mapPermissionRequest(frame, ctx);
  }

  // Unknown method — drop
  return [];
};

// ---- session/update dispatch ----

const mapSessionUpdate = async (
  frame: Record<string, unknown>,
  ctx: AcpMapperContext
): Promise<AgentSessionStreamEvent[]> => {
  const params = frame.params as { update?: Record<string, unknown> } | undefined;
  const update = params?.update;
  if (update == null) return [];

  const updateType = update.sessionUpdate as string | undefined;

  switch (updateType) {
    case "agent_message_chunk":
      return mapAgentMessage(update, ctx);

    case "agent_thought_chunk":
      return mapAgentThought(update, ctx);

    case "plan":
      return await mapPlan(update, ctx);

    case "tool_call":
      return mapToolCall(update, ctx);

    case "tool_call_update":
      return await mapToolCallUpdate(update, ctx);

    case "user_message_chunk":
      return mapUserMessage(update, ctx);

    default:
      // Unknown update type — emit as structured output
      return [
        safeEmit(
          {
            ...buildContext(ctx),
            type: "output",
            stream: "structured",
            text: sanitizeTextField(JSON.stringify(update)) ?? "{}"
          },
          ctx
        )
      ];
  }
};

// ---- agent_message_chunk → message ----

const mapAgentMessage = (
  update: Record<string, unknown>,
  ctx: AcpMapperContext
): AgentSessionStreamEvent[] => {
  const content = update.content as { text?: string } | undefined;
  const text = sanitizeTextField(content?.text ?? "");
  if (text == null) return [];

  return [
    safeEmit(
      { ...buildContext(ctx), type: "message", role: "assistant", text },
      ctx
    )
  ];
};

// ---- agent_thought_chunk → thought_summary ----

const mapAgentThought = (
  update: Record<string, unknown>,
  ctx: AcpMapperContext
): AgentSessionStreamEvent[] => {
  const content = update.content as { text?: string } | undefined;
  const text = sanitizeTextField(content?.text ?? "", { maxBytes: 20_000 });
  if (text == null) return [];

  return [
    safeEmit(
      { ...buildContext(ctx), type: "thought_summary", text },
      ctx
    )
  ];
};

// ---- plan → plan or output ----

const mapPlan = async (
  update: Record<string, unknown>,
  ctx: AcpMapperContext
): Promise<AgentSessionStreamEvent[]> => {
  const entries = update.entries as Array<{ content: string; priority: string; status: string }> | undefined;
  if (entries == null) return [];

  const summary = entries
    .map((e) => `[${e.status}] ${e.content}`)
    .join("\n");

  if (!ctx.structuredPlans) {
    // Not structured — emit as output
    const text = sanitizeTextField(summary) ?? "Plan update";
    return [
      safeEmit(
        { ...buildContext(ctx), type: "output", stream: "structured", text },
        ctx
      )
    ];
  }

  // Structured plan — record evidence and emit
  const planBytes = Buffer.from(JSON.stringify(entries), "utf8");
  const { digest } = await ctx.evidenceSink.record({
    kind: "plan",
    bytes: new Uint8Array(planBytes)
  });

  const sanitizedSummary = sanitizeTextField(summary, { maxBytes: 20_000 }) ?? "Plan update";

  return [
    safeEmit(
      {
        ...buildContext(ctx),
        type: "plan",
        planDigest: digest,
        summary: sanitizedSummary
      },
      ctx
    )
  ];
};

// ---- tool_call → tool_call started ----

const mapToolCall = (
  update: Record<string, unknown>,
  ctx: AcpMapperContext
): AgentSessionStreamEvent[] => {
  const toolCallId = update.toolCallId as string | undefined;
  const title = update.title as string | undefined;
  if (toolCallId == null || title == null) return [];

  const name = sanitizeTextField(title, { maxBytes: 200 }) ?? "Unknown tool";

  return [
    safeEmit(
      {
        ...buildContext(ctx),
        type: "tool_call",
        toolCallRef: toolCallId,
        name,
        phase: "started"
      },
      ctx
    )
  ];
};

// ---- tool_call_update → tool_call completed/failed + file_change ----

const mapToolCallUpdate = async (
  update: Record<string, unknown>,
  ctx: AcpMapperContext
): Promise<AgentSessionStreamEvent[]> => {
  const toolCallId = update.toolCallId as string | undefined;
  const status = update.status as string | undefined;
  const content = update.content as Array<Record<string, unknown>> | undefined;
  if (toolCallId == null) return [];

  const events: AgentSessionStreamEvent[] = [];

  // Extract file changes from diff content items
  if (content != null) {
    for (const item of content) {
      if (item.type === "diff") {
        const path = item.path as string | undefined;
        const oldText = item.oldText as string | null | undefined;
        const newText = item.newText as string | null | undefined;

        if (path != null) {
          const relPath = relativizePath(path, ctx.workspaceCwd);
          if (relPath != null) {
            // Valid workspace path — emit file_change
            const change = classifyChange(oldText, newText);

            // Record diff evidence
            const diffContent = JSON.stringify({ path: relPath, oldText, newText });
            const { digest } = await ctx.evidenceSink.record({
              kind: "diff",
              bytes: new Uint8Array(Buffer.from(diffContent, "utf8"))
            });

            events.push(
              safeEmit(
                {
                  ...buildContext(ctx),
                  type: "file_change",
                  path: relPath,
                  change,
                  diffDigest: digest
                },
                ctx
              )
            );
          } else {
            // Outside workspace — emit as output (security)
            const text = sanitizeTextField(
              `File change outside workspace: ${path}`
            ) ?? "File change outside workspace";
            events.push(
              safeEmit(
                { ...buildContext(ctx), type: "output", stream: "structured", text },
                ctx
              )
            );
          }
        }
      }
    }
  }

  // Emit the tool_call completed/failed
  const phase = status === "completed" ? "completed" : status === "failed" ? "failed" : "completed";
  events.push(
    safeEmit(
      {
        ...buildContext(ctx),
        type: "tool_call",
        toolCallRef: toolCallId,
        name: toolCallId, // The update doesn't repeat the title; use the ref as fallback
        phase
      },
      ctx
    )
  );

  return events;
};

// ---- user_message_chunk → output (structured) ----

const mapUserMessage = (
  update: Record<string, unknown>,
  ctx: AcpMapperContext
): AgentSessionStreamEvent[] => {
  const content = update.content as { text?: string; type?: string } | undefined;
  const text = sanitizeTextField(content?.text ?? "");
  if (text == null) return [];

  return [
    safeEmit(
      { ...buildContext(ctx), type: "output", stream: "structured", text },
      ctx
    )
  ];
};

// ---- session/request_permission → permission_requested ----

const mapPermissionRequest = async (
  frame: Record<string, unknown>,
  ctx: AcpMapperContext
): Promise<AgentSessionStreamEvent[]> => {
  const params = frame.params as Record<string, unknown> | undefined;
  if (params == null) return [];

  const toolCall = params.toolCall as Record<string, unknown> | undefined;
  const options = params.options as Array<Record<string, unknown>> | undefined;
  if (toolCall == null || options == null) return [];

  const toolCallId = toolCall.toolCallId as string;
  const title = toolCall.title as string;

  // Record the permission evidence
  const permBytes = Buffer.from(JSON.stringify({
    toolCallId,
    title,
    options: options.map(o => ({
      optionId: o.optionId,
      kind: o.kind,
      label: o.name
    }))
  }), "utf8");

  const { digest } = await ctx.evidenceSink.record({
    kind: "permission",
    bytes: new Uint8Array(permBytes)
  });

  const summary = sanitizeTextField(
    `Permission required: ${title}`,
    { maxBytes: 2_000 }
  ) ?? "Permission required";

  return [
    safeEmit(
      {
        ...buildContext(ctx),
        type: "permission_requested",
        permissionRef: toolCallId,
        summary,
        evidenceDigest: digest
      },
      ctx
    )
  ];
};

// ---- stopReason → completed ----

const mapStopReason = async (
  stopReason: string,
  ctx: AcpMapperContext
): Promise<AgentSessionStreamEvent[]> => {
  // Record transcript evidence for the completed session
  const transcriptBytes = Buffer.from(
    JSON.stringify({ stopReason, completedAt: now() }),
    "utf8"
  );
  const { digest } = await ctx.evidenceSink.record({
    kind: "transcript",
    bytes: new Uint8Array(transcriptBytes)
  });

  // Allocate sequence before marking terminal
  const completedCtx = buildContext(ctx);
  ctx.sequencer.markTerminal();

  return [
    safeEmit(
      {
        ...completedCtx,
        type: "completed",
        evidenceDigests: [digest]
      },
      ctx
    )
  ];
};
