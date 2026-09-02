/**
 * Claude Code stream-json frame types.
 *
 * Typed representations of the frames emitted by `claude -p --output-format stream-json`.
 * These are input types — they describe the provider's shape, not our output. They are
 * validated with Zod to fail closed on unrecognised shapes rather than proceeding with
 * unknown data.
 *
 * Frame types observed in Task 1 transcripts:
 * - `system/init`: session initialization, model, tools, session_id
 * - `assistant`: messages from the model (text, tool_use, thinking blocks)
 * - `user`: tool results
 * - `result`: session/turn result with usage, is_error, subtype
 * - `system/task_summary`: task summaries (dropped)
 * - `system/post_turn_summary`: post-turn summaries (dropped)
 * - `rate_limit_event`: rate limiting info (dropped)
 * - JSON-RPC `tools/call` with `approve`: permission request (handled separately)
 */

import { z } from "zod";

// ---- Content blocks ----

export const ClaudeTextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string()
}).passthrough();

export const ClaudeToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).optional()
}).passthrough();

export const ClaudeThinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string()
}).passthrough();

export const ClaudeContentBlockSchema = z.discriminatedUnion("type", [
  ClaudeTextBlockSchema,
  ClaudeToolUseBlockSchema,
  ClaudeThinkingBlockSchema,
  // Catch-all for other content types (tool_result, etc.)
  z.object({ type: z.string() }).passthrough()
]);

// ---- Per-message usage ----

export const ClaudeMessageUsageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional()
}).passthrough();

// ---- Assistant message ----

export const ClaudeAssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  model: z.string().optional(),
  content: z.array(z.record(z.string(), z.unknown())).default([]),
  usage: ClaudeMessageUsageSchema.optional(),
  stop_reason: z.string().nullable().optional()
}).passthrough();

// ---- Frame types ----

export const ClaudeSystemInitFrameSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string(),
  model: z.string().optional(),
  cwd: z.string().optional()
}).passthrough();

export const ClaudeAssistantFrameSchema = z.object({
  type: z.literal("assistant"),
  message: ClaudeAssistantMessageSchema,
  session_id: z.string().optional()
}).passthrough();

export const ClaudeUserFrameSchema = z.object({
  type: z.literal("user"),
  message: z.object({
    role: z.literal("user"),
    content: z.array(z.record(z.string(), z.unknown())).default([])
  }).passthrough(),
  tool_use_result: z.unknown().optional()
}).passthrough();

export const ClaudeResultUsageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  output_tokens_details: z.object({
    thinking_tokens: z.number().optional()
  }).passthrough().optional()
}).passthrough();

export const ClaudeResultFrameSchema = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.unknown().optional(),
  stop_reason: z.string().nullable().optional(),
  total_cost_usd: z.number().optional(),
  usage: ClaudeResultUsageSchema.optional()
}).passthrough();

// ---- JSON-RPC permission request ----

export const ClaudePermissionRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number(),
  method: z.literal("tools/call"),
  params: z.object({
    name: z.literal("approve"),
    arguments: z.object({
      tool_name: z.string(),
      input: z.record(z.string(), z.unknown()).optional(),
      tool_use_id: z.string()
    }).passthrough()
  }).passthrough()
});

// ---- Type exports ----

export type ClaudeSystemInitFrame = z.infer<typeof ClaudeSystemInitFrameSchema>;
export type ClaudeAssistantFrame = z.infer<typeof ClaudeAssistantFrameSchema>;
export type ClaudeUserFrame = z.infer<typeof ClaudeUserFrameSchema>;
export type ClaudeResultFrame = z.infer<typeof ClaudeResultFrameSchema>;
export type ClaudePermissionRequest = z.infer<typeof ClaudePermissionRequestSchema>;

/** Discriminator for the top-level frame type. */
export const classifyClaudeFrame = (frame: Record<string, unknown>): string => {
  if (frame.jsonrpc === "2.0" && frame.method === "tools/call") return "permission_request";
  const type = frame.type as string | undefined;
  if (type === "system") {
    const subtype = frame.subtype as string | undefined;
    return `system/${subtype ?? "unknown"}`;
  }
  return type ?? "unknown";
};
