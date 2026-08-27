import { describe, expect, it } from "vitest";

import { CHILD_LOG_LIMITS, createChildLogForwarder } from "../src/main/child-log.js";

const CREDENTIAL = `ghp_${"a".repeat(36)}`;

const collect = (): { lines: string[]; write: (line: string) => void } => {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
};

describe("utility child log forwarder", () => {
  it("emits one structured record per complete line", () => {
    const sink = collect();
    const forwarder = createChildLogForwarder({ service: "host", write: sink.write });

    forwarder.push("first\nsecond\n");

    expect(sink.lines.map((line) => JSON.parse(line))).toEqual([
      { level: "error", event: "utility_child_log", service: "host", line: "first" },
      { level: "error", event: "utility_child_log", service: "host", line: "second" }
    ]);
  });

  it("holds a partial line until its newline arrives", () => {
    const sink = collect();
    const forwarder = createChildLogForwarder({ service: "host", write: sink.write });

    forwarder.push("par");
    expect(sink.lines).toEqual([]);
    forwarder.push("tial\n");

    expect(JSON.parse(sink.lines[0] ?? "{}")).toMatchObject({ line: "partial" });
  });

  it("flushes a trailing line that never got its newline", () => {
    const sink = collect();
    const forwarder = createChildLogForwarder({ service: "control-plane", write: sink.write });

    forwarder.push("no newline here");
    expect(sink.lines).toEqual([]);
    forwarder.flush();

    expect(JSON.parse(sink.lines[0] ?? "{}")).toMatchObject({
      service: "control-plane",
      line: "no newline here"
    });
  });

  it("redacts a credential a child prints", () => {
    const sink = collect();
    const forwarder = createChildLogForwarder({ service: "host", write: sink.write });

    forwarder.push(`bootstrap rejected using ${CREDENTIAL}\n`);

    const record = JSON.parse(sink.lines[0] ?? "{}") as { line: string };
    expect(sink.lines[0]).not.toContain(CREDENTIAL);
    expect(sink.lines[0]).not.toContain("ghp_");
    expect(record.line.length).toBeGreaterThan(0);
  });

  it("bounds a single runaway line", () => {
    const sink = collect();
    const forwarder = createChildLogForwarder({ service: "host", write: sink.write });

    forwarder.push(`${"x".repeat(CHILD_LOG_LIMITS.maximumLineCharacters * 4)}\n`);

    const record = JSON.parse(sink.lines[0] ?? "{}") as { line: string };
    expect(record.line.length).toBeLessThanOrEqual(CHILD_LOG_LIMITS.maximumLineCharacters);
  });

  it("stops after the total budget and says so exactly once", () => {
    const sink = collect();
    const forwarder = createChildLogForwarder({ service: "host", write: sink.write });

    const line = `${"y".repeat(CHILD_LOG_LIMITS.maximumLineCharacters)}\n`;
    for (let index = 0; index < 200; index += 1) forwarder.push(line);
    forwarder.push("after the budget\n");
    forwarder.flush();

    const events = sink.lines.map((entry) => (JSON.parse(entry) as { event: string }).event);
    expect(events.filter((event) => event === "utility_child_log_truncated")).toHaveLength(1);
    expect(events.at(-1)).toBe("utility_child_log_truncated");
    expect(sink.lines.join("").length).toBeLessThan(
      CHILD_LOG_LIMITS.maximumTotalCharacters + CHILD_LOG_LIMITS.maximumLineCharacters * 2
    );
    expect(sink.lines.join("")).not.toContain("after the budget");
  });

  it("never lets an unterminated stream grow the buffer without bound", () => {
    const sink = collect();
    const forwarder = createChildLogForwarder({ service: "host", write: sink.write });

    for (let index = 0; index < 8; index += 1) {
      forwarder.push("z".repeat(CHILD_LOG_LIMITS.maximumLineCharacters));
    }

    expect(sink.lines.length).toBeGreaterThan(0);
    for (const entry of sink.lines) {
      const record = JSON.parse(entry) as { line?: string };
      expect((record.line ?? "").length).toBeLessThanOrEqual(
        CHILD_LOG_LIMITS.maximumLineCharacters
      );
    }
  });
});
