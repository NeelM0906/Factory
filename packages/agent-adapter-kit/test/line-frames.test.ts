import { describe, expect, it } from "vitest";

import {
  LineFrameReader,
  type FrameReaderResult,
  DEFAULT_MAX_LINE_BYTES
} from "../src/line-frames.js";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const collectResults = (reader: LineFrameReader, chunks: readonly Uint8Array[]): FrameReaderResult[] => {
  const results: FrameReaderResult[] = [];
  for (const chunk of chunks) {
    results.push(...reader.feed(chunk));
  }
  return results;
};

const collectAll = (reader: LineFrameReader, chunks: readonly Uint8Array[]): FrameReaderResult[] => {
  const results = collectResults(reader, chunks);
  results.push(...reader.end());
  return results;
};

const frames = (results: readonly FrameReaderResult[]): unknown[] =>
  results.filter((r) => r.kind === "frame").map((r) => r.value);

const failures = (results: readonly FrameReaderResult[]): FrameReaderResult[] =>
  results.filter((r) => r.kind === "failure");

describe("LineFrameReader", () => {
  describe("reassembly", () => {
    it("parses a complete JSON line delivered in one chunk", () => {
      const reader = new LineFrameReader();
      const results = collectAll(reader, [encode('{"type":"init"}\n')]);
      expect(frames(results)).toEqual([{ type: "init" }]);
      expect(failures(results)).toHaveLength(0);
    });

    it("reassembles a frame split across three chunk boundaries", () => {
      const reader = new LineFrameReader();
      const line = '{"type":"message","text":"hello world"}\n';
      const part1 = encode(line.slice(0, 10));
      const part2 = encode(line.slice(10, 25));
      const part3 = encode(line.slice(25));

      const results = collectAll(reader, [part1, part2, part3]);
      expect(frames(results)).toEqual([{ type: "message", text: "hello world" }]);
      expect(failures(results)).toHaveLength(0);
    });

    it("emits multiple frames delivered in a single chunk, in order", () => {
      const reader = new LineFrameReader();
      const combined = encode(
        '{"seq":1}\n{"seq":2}\n{"seq":3}\n'
      );
      const results = collectAll(reader, [combined]);
      expect(frames(results)).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
    });
  });

  describe("line terminators", () => {
    it("accepts \\n as a terminator", () => {
      const reader = new LineFrameReader();
      const results = collectAll(reader, [encode('{"a":1}\n')]);
      expect(frames(results)).toEqual([{ a: 1 }]);
    });

    it("accepts \\r\\n as a terminator", () => {
      const reader = new LineFrameReader();
      const results = collectAll(reader, [encode('{"a":1}\r\n')]);
      expect(frames(results)).toEqual([{ a: 1 }]);
    });
  });

  describe("byte cap enforcement", () => {
    it("yields a classified provider_output_malformed failure for a line over the byte cap", () => {
      const reader = new LineFrameReader({ maxLineBytes: 64 });
      const oversized = encode(`{"data":"${"x".repeat(100)}"}\n`);

      const results = collectAll(reader, [oversized]);
      expect(frames(results)).toHaveLength(0);
      expect(failures(results)).toHaveLength(1);
      expect(failures(results)[0]).toMatchObject({
        kind: "failure",
        code: "provider_output_malformed"
      });
    });

    it("does not carry provider text in the failure — the cap exists because the line is untrusted", () => {
      const reader = new LineFrameReader({ maxLineBytes: 64 });
      const payload = "x".repeat(100);
      const oversized = encode(`{"data":"${payload}"}\n`);

      const results = collectAll(reader, [oversized]);
      const fail = failures(results)[0];
      expect(JSON.stringify(fail)).not.toContain(payload);
    });

    it("recovers after an oversized line and parses the next frame", () => {
      const reader = new LineFrameReader({ maxLineBytes: 64 });
      const oversized = encode(`{"data":"${"x".repeat(100)}"}\n`);
      const normal = encode('{"ok":true}\n');

      const results = collectAll(reader, [oversized, normal]);
      expect(frames(results)).toEqual([{ ok: true }]);
      expect(failures(results)).toHaveLength(1);
    });
  });

  describe("invalid JSON", () => {
    it("yields a classified provider_output_malformed failure for invalid JSON", () => {
      const reader = new LineFrameReader();
      const results = collectAll(reader, [encode("not json at all\n")]);

      expect(frames(results)).toHaveLength(0);
      expect(failures(results)).toHaveLength(1);
      expect(failures(results)[0]).toMatchObject({
        kind: "failure",
        code: "provider_output_malformed"
      });
    });

    it("does not carry provider text in the failure", () => {
      const reader = new LineFrameReader();
      const badLine = "this is secret provider garbage";
      const results = collectAll(reader, [encode(`${badLine}\n`)]);

      const fail = failures(results)[0];
      expect(JSON.stringify(fail)).not.toContain(badLine);
    });
  });

  describe("trailing partial line at EOF", () => {
    it("yields a classified failure for a trailing partial line, never a silently dropped frame", () => {
      const reader = new LineFrameReader();
      // Feed a partial line with no newline, then end the stream
      const results: FrameReaderResult[] = [...reader.feed(encode('{"partial":true'))];
      results.push(...reader.end());

      expect(frames(results)).toHaveLength(0);
      expect(failures(results)).toHaveLength(1);
      expect(failures(results)[0]).toMatchObject({
        kind: "failure",
        code: "provider_output_malformed"
      });
    });

    it("end() on an empty buffer yields no failures", () => {
      const reader = new LineFrameReader();
      const results = reader.end();
      expect(results).toHaveLength(0);
    });
  });

  describe("counters", () => {
    it("tracks observedBytes and emittedFrames for quiesce", () => {
      const reader = new LineFrameReader();
      const chunk = encode('{"a":1}\n{"b":2}\n');

      expect(reader.observedBytes).toBe(0);
      expect(reader.emittedFrames).toBe(0);

      reader.feed(chunk);

      expect(reader.observedBytes).toBe(chunk.byteLength);
      expect(reader.emittedFrames).toBe(2);
    });

    it("counters increase monotonically across multiple feeds", () => {
      const reader = new LineFrameReader();
      const chunk1 = encode('{"a":1}\n');
      const chunk2 = encode('{"b":2}\n');

      reader.feed(chunk1);
      const bytes1 = reader.observedBytes;
      const frames1 = reader.emittedFrames;

      reader.feed(chunk2);
      expect(reader.observedBytes).toBeGreaterThan(bytes1);
      expect(reader.emittedFrames).toBeGreaterThan(frames1);
    });
  });

  describe("byte stream integrity (D-4)", () => {
    it("never modifies the bytes it receives — the frame reader sees raw bytes", () => {
      const reader = new LineFrameReader();
      // Include a credential-shaped value in the JSON — the reader must not redact it.
      // Redaction happens per-field after parse, never at the byte level.
      const credential = ["ghp", "abc123def456ghi789jkl012mno345pqr67890"].join("_");
      const line = JSON.stringify({ token: credential }) + "\n";
      const chunk = encode(line);

      const results = collectAll(reader, [chunk]);
      const parsed = frames(results);
      expect(parsed).toHaveLength(1);
      expect((parsed[0] as Record<string, unknown>).token).toBe(credential);
    });
  });

  describe("empty lines", () => {
    it("skips empty lines between frames", () => {
      const reader = new LineFrameReader();
      const results = collectAll(reader, [encode('\n\n{"a":1}\n\n')]);
      // Empty lines should not produce failures — they are common in line-delimited protocols
      expect(frames(results)).toEqual([{ a: 1 }]);
    });
  });
});
