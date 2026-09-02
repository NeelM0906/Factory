/**
 * Tests for Claude Code frame classification and parsing.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyClaudeFrame,
  ClaudeSystemInitFrameSchema,
  ClaudeAssistantFrameSchema,
  ClaudeResultFrameSchema,
  ClaudePermissionRequestSchema
} from "../src/claude-frames.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const transcriptsDir = resolve(__dirname, "fixtures/transcripts");

const loadTranscript = (name: string) =>
  JSON.parse(readFileSync(resolve(transcriptsDir, `${name}.json`), "utf8"));

describe("claude-frames", () => {
  describe("classifyClaudeFrame", () => {
    it("classifies system/init frames", () => {
      const transcript = loadTranscript("claude-completes");
      const initFrame = transcript.frames[0].value;
      expect(classifyClaudeFrame(initFrame)).toBe("system/init");
    });

    it("classifies assistant frames", () => {
      const transcript = loadTranscript("claude-completes");
      const frame = transcript.frames[1].value;
      expect(classifyClaudeFrame(frame)).toBe("assistant");
    });

    it("classifies result frames", () => {
      const transcript = loadTranscript("claude-completes");
      const resultFrame = transcript.frames.find(
        (f: Record<string, unknown>) =>
          f.kind === "emit" && (f.value as Record<string, unknown>).type === "result"
      )!.value;
      expect(classifyClaudeFrame(resultFrame)).toBe("result");
    });

    it("classifies JSON-RPC permission requests", () => {
      const transcript = loadTranscript("claude-requests_permission");
      const permFrame = transcript.frames.find(
        (f: Record<string, unknown>) =>
          f.kind === "emit" && (f.value as Record<string, unknown>).jsonrpc === "2.0"
      )!.value;
      expect(classifyClaudeFrame(permFrame)).toBe("permission_request");
    });

    it("classifies rate_limit_event", () => {
      expect(classifyClaudeFrame({ type: "rate_limit_event" })).toBe("rate_limit_event");
    });

    it("classifies system/task_summary", () => {
      expect(classifyClaudeFrame({ type: "system", subtype: "task_summary" })).toBe(
        "system/task_summary"
      );
    });
  });

  describe("schema parsing", () => {
    it("parses a real system/init frame", () => {
      const transcript = loadTranscript("claude-completes");
      const frame = transcript.frames[0].value;
      const parsed = ClaudeSystemInitFrameSchema.parse(frame);
      expect(parsed.session_id).toBe("11111111-2222-4333-8444-555555555555");
    });

    it("parses a real assistant frame with tool_use", () => {
      const transcript = loadTranscript("claude-completes");
      // Frame 2 has tool_use
      const frame = transcript.frames[2].value;
      const parsed = ClaudeAssistantFrameSchema.parse(frame);
      expect(parsed.message.role).toBe("assistant");
      expect(parsed.message.content.length).toBeGreaterThan(0);
    });

    it("parses a real result frame", () => {
      const transcript = loadTranscript("claude-completes");
      const resultFrame = transcript.frames.find(
        (f: Record<string, unknown>) =>
          f.kind === "emit" && (f.value as Record<string, unknown>).type === "result"
      )!.value;
      const parsed = ClaudeResultFrameSchema.parse(resultFrame);
      expect(parsed.is_error).toBe(false);
      expect(parsed.subtype).toBe("success");
    });

    it("parses a real permission request", () => {
      const transcript = loadTranscript("claude-requests_permission");
      const permFrame = transcript.frames.find(
        (f: Record<string, unknown>) =>
          f.kind === "emit" && (f.value as Record<string, unknown>).jsonrpc === "2.0"
      )!.value;
      const parsed = ClaudePermissionRequestSchema.parse(permFrame);
      expect(parsed.params.name).toBe("approve");
      expect(parsed.params.arguments.tool_name).toBe("Write");
      expect(parsed.params.arguments.tool_use_id).toBe("toolu_01ABN8frqqE4AY1GFpqWqqjq");
    });
  });
});
