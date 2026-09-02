/**
 * Codex app-server event mapper: pure functions from one Codex notification
 * to zero or more AgentSessionStreamEvent values.
 *
 * Every produced event goes through AgentSessionStreamEventSchema.parse before
 * it leaves. A parse failure becomes provider_output_malformed, keeping the
 * fail-closed rule from turning a bad frame into a thrown exception at the port.
 *
 * Redaction is per-field after JSON parse (D-4).
 *
 * Usage honesty (behaviour 8):
 * - thread/tokenUsage/updated reports inputTokens, cachedInputTokens,
 *   outputTokens, reasoningOutputTokens — all four token figures are reported.
 * - Cost is never reported by the Codex protocol, so cost: { state: "unknown" }.
 */

import {
  EventSequencer,
  sanitizeTextField,
  type AgentEvidenceSink
} from "@autostack/agent-adapter-kit";

import {
  AgentSessionStreamEventSchema,
  type AgentSessionStreamEvent
} from "@autostack/contracts";

import type { CodexNotification } from "./codex-jsonrpc.js";

// ---- Public types ----

export interface CodexMapperContext {
  readonly sessionId: string;
  readonly providerSessionRef: string;
  readonly sequencer: EventSequencer;
  readonly evidenceSink: AgentEvidenceSink;
  readonly workspaceCwd: string;
}

// ---- Internal helpers ----

const SCHEMA_VERSION = 1 as const;

const now = (): string => new Date().toISOString();

const buildContext = (ctx: CodexMapperContext) => ({
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
  ctx: CodexMapperContext
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
    message: "Codex frame could not be mapped to a valid event.",
    retryable: false
  });
};

// ---- Main mapper ----

/**
 * Map one Codex app-server notification to zero or more normalized events.
 * Response frames (id-bearing) are handled by CodexJsonRpcClient, not here.
 */
export const mapCodexNotification = async (
  notification: CodexNotification,
  ctx: CodexMapperContext
): Promise<AgentSessionStreamEvent[]> => {
  const method = notification.method;
  const params = notification.params;

  switch (method) {
    case "item/started":
      return mapItemStarted(params, ctx);

    case "item/completed":
      return mapItemCompleted(params, ctx);

    case "item/agentMessage/delta":
      return mapAgentMessageDelta(params, ctx);

    case "thread/tokenUsage/updated":
      return mapTokenUsage(params, ctx);

    case "item/commandExecution/requestApproval":
      return await mapApprovalRequest(notification, ctx);

    case "error":
      return mapErrorNotification(params, ctx);

    // Dropped notification types
    case "thread/started":
    case "turn/started":
    case "turn/completed":
    case "thread/status/changed":
    case "remoteControl/status/changed":
    case "warning":
    case "serverRequest/resolved":
      return [];

    default:
      return [];
  }
};

// ---- item/started -> message | tool_call ----

const mapItemStarted = (
  params: Record<string, unknown>,
  ctx: CodexMapperContext
): AgentSessionStreamEvent[] => {
  const item = params.item as Record<string, unknown> | undefined;
  if (item == null) return [];

  const itemType = item.type as string | undefined;
  const itemId = item.id as string | undefined;

  if (itemType === "agentMessage") {
    // Agent message started — we emit the message text only on delta or completed
    return [];
  }

  if (itemType === "commandExecution" && itemId != null) {
    const command = item.command as string | undefined;
    const name = sanitizeTextField(
      command ?? "commandExecution",
      { maxBytes: 200 }
    ) ?? "commandExecution";
    return [
      safeEmit(
        {
          ...buildContext(ctx),
          type: "tool_call",
          toolCallRef: itemId,
          name,
          phase: "started"
        },
        ctx
      )
    ];
  }

  return [];
};

// ---- item/completed -> message | tool_call completed | file_change ----

const mapItemCompleted = (
  params: Record<string, unknown>,
  ctx: CodexMapperContext
): AgentSessionStreamEvent[] => {
  const item = params.item as Record<string, unknown> | undefined;
  if (item == null) return [];

  const itemType = item.type as string | undefined;
  const itemId = item.id as string | undefined;

  if (itemType === "agentMessage") {
    const rawText = item.text as string | undefined;
    const text = rawText != null ? sanitizeTextField(rawText) : undefined;
    if (text != null) {
      return [
        safeEmit(
          { ...buildContext(ctx), type: "message", role: "assistant", text },
          ctx
        )
      ];
    }
    return [];
  }

  if (itemType === "commandExecution" && itemId != null) {
    const status = item.status as string | undefined;
    const phase = status === "completed" ? "completed" : "failed";
    const command = item.command as string | undefined;
    const name = sanitizeTextField(
      command ?? "commandExecution",
      { maxBytes: 200 }
    ) ?? "commandExecution";
    return [
      safeEmit(
        {
          ...buildContext(ctx),
          type: "tool_call",
          toolCallRef: itemId,
          name,
          phase
        },
        ctx
      )
    ];
  }

  if (itemType === "fileChange") {
    return mapFileChange(item, ctx);
  }

  return [];
};

// ---- file_change ----

const mapFileChange = (
  item: Record<string, unknown>,
  ctx: CodexMapperContext
): AgentSessionStreamEvent[] => {
  const changes = item.changes as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(changes)) return [];

  const events: AgentSessionStreamEvent[] = [];

  for (const change of changes) {
    const rawPath = change.path as string | undefined;
    if (rawPath == null) continue;

    // Relativize against cwd — the path in the transcript is already relative
    const path = rawPath;

    const kind = change.kind as string | undefined;
    let changeType: "added" | "modified" | "deleted";
    if (kind === "add") {
      changeType = "added";
    } else if (kind === "delete") {
      changeType = "deleted";
    } else {
      changeType = "modified";
    }

    events.push(
      safeEmit(
        {
          ...buildContext(ctx),
          type: "file_change",
          path,
          change: changeType
        },
        ctx
      )
    );
  }

  return events;
};

// ---- item/agentMessage/delta -> message ----

const mapAgentMessageDelta = (
  params: Record<string, unknown>,
  ctx: CodexMapperContext
): AgentSessionStreamEvent[] => {
  const delta = params.delta as string | undefined;
  if (delta == null) return [];
  const text = sanitizeTextField(delta);
  if (text == null) return [];

  return [
    safeEmit(
      { ...buildContext(ctx), type: "message", role: "assistant", text },
      ctx
    )
  ];
};

// ---- thread/tokenUsage/updated -> usage ----

const mapTokenUsage = (
  params: Record<string, unknown>,
  ctx: CodexMapperContext
): AgentSessionStreamEvent[] => {
  const tokenUsage = params.tokenUsage as Record<string, unknown> | undefined;
  if (tokenUsage == null) return [];

  // Use the "total" bucket if available, else "last"
  const bucket = (tokenUsage.total ?? tokenUsage.last) as Record<string, unknown> | undefined;
  if (bucket == null) return [];

  const tokens = {
    input: typeof bucket.inputTokens === "number"
      ? { state: "reported" as const, value: bucket.inputTokens }
      : { state: "unknown" as const },
    output: typeof bucket.outputTokens === "number"
      ? { state: "reported" as const, value: bucket.outputTokens }
      : { state: "unknown" as const },
    cachedInput: typeof bucket.cachedInputTokens === "number"
      ? { state: "reported" as const, value: bucket.cachedInputTokens }
      : { state: "unknown" as const },
    reasoning: typeof bucket.reasoningOutputTokens === "number"
      ? { state: "reported" as const, value: bucket.reasoningOutputTokens }
      : { state: "unknown" as const }
  };

  // Codex never reports cost
  const cost = { state: "unknown" as const };

  return [
    safeEmit(
      { ...buildContext(ctx), type: "usage", tokens, cost },
      ctx
    )
  ];
};

// ---- approval request -> permission_requested ----

const mapApprovalRequest = async (
  notification: CodexNotification,
  ctx: CodexMapperContext
): Promise<AgentSessionStreamEvent[]> => {
  const params = notification.params;
  const itemId = params.itemId as string | undefined;
  const reason = params.reason as string | undefined;
  const command = params.command as string | undefined;

  if (itemId == null) return [];

  // Record permission evidence
  const permBytes = Buffer.from(
    JSON.stringify({
      itemId,
      reason,
      command,
      kind: params.kind
    }),
    "utf8"
  );
  const { digest } = await ctx.evidenceSink.record({
    kind: "permission",
    bytes: new Uint8Array(permBytes)
  });

  const summary = sanitizeTextField(
    reason ?? `Permission required: ${command ?? "unknown command"}`,
    { maxBytes: 2_000 }
  ) ?? "Permission required";

  return [
    safeEmit(
      {
        ...buildContext(ctx),
        type: "permission_requested",
        permissionRef: itemId,
        summary,
        evidenceDigest: digest
      },
      ctx
    )
  ];
};

// ---- error notification -> failed ----

const mapErrorNotification = (
  params: Record<string, unknown>,
  ctx: CodexMapperContext
): AgentSessionStreamEvent[] => {
  const error = params.error as Record<string, unknown> | undefined;
  const errorMessage = error?.message as string | undefined;

  const message = sanitizeTextField(
    errorMessage ?? "Codex reported an error.",
    { maxBytes: 2_000 }
  ) ?? "Codex reported an error.";

  const failedCtx = buildContext(ctx);
  ctx.sequencer.markTerminal();

  return [
    safeEmit(
      {
        ...failedCtx,
        type: "failed",
        code: "provider_execution_error",
        message,
        retryable: true
      },
      ctx
    )
  ];
};
