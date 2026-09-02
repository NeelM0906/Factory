#!/usr/bin/env node
/**
 * Fixture ACP agent: speaks ACP v1 JSON-RPC 2.0 over stdio, replaying a
 * transcript from a file path passed on argv.
 *
 * Usage: node acp-agent.mjs <transcript-path> [scenario-override]
 *
 * Reads the transcript JSON, iterates its frames, and for each:
 * - "emit":        writes the value as one JSON line to stdout
 * - "emitStderr":  writes the text to stderr
 * - "awaitStdin":  waits for a line on stdin whose parsed JSON is a structural
 *                  superset of `match`
 * - "exit":        exits with the given code or signal
 *
 * This script is a real child process, so the adapter runs against a real
 * macrotask transport. It carries no knowledge of the conformance suite.
 */

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

const [transcriptPath, scenarioOverride] = process.argv.slice(2);

if (!transcriptPath) {
  process.stderr.write("acp-agent.mjs: transcript path required\n");
  process.exit(2);
}

const fixture = JSON.parse(readFileSync(transcriptPath, "utf8"));
const frames = fixture.frames;

// Stdin line reader
const rl = createInterface({ input: process.stdin, terminal: false });
const stdinLines = [];
let stdinResolve = null;

rl.on("line", (line) => {
  stdinLines.push(line);
  if (stdinResolve) {
    const resolve = stdinResolve;
    stdinResolve = null;
    resolve();
  }
});

const waitForLine = () => {
  if (stdinLines.length > 0) return Promise.resolve();
  return new Promise((resolve) => {
    stdinResolve = resolve;
  });
};

/**
 * Structural subset match: every key in `pattern` must exist in `value` and
 * match recursively. Extra keys in `value` are ignored — this is what makes
 * fixtures resilient to ids the client mints.
 */
const structuralMatch = (value, pattern) => {
  if (pattern === null || pattern === undefined) return value === pattern;
  if (typeof pattern !== "object") return value === pattern;
  if (Array.isArray(pattern)) {
    if (!Array.isArray(value) || value.length !== pattern.length) return false;
    return pattern.every((p, i) => structuralMatch(value[i], p));
  }
  if (typeof value !== "object" || value === null) return false;
  return Object.keys(pattern).every((key) => structuralMatch(value[key], pattern[key]));
};

const writeLine = (value) => {
  const line = typeof value === "string" ? value : JSON.stringify(value);
  process.stdout.write(line + "\n");
};

// Replay the transcript
for (const frame of frames) {
  switch (frame.kind) {
    case "emit":
      writeLine(frame.value);
      break;

    case "emitStderr":
      process.stderr.write(frame.text);
      break;

    case "awaitStdin": {
      // Wait for a matching stdin line
      let matched = false;
      while (!matched) {
        await waitForLine();
        const line = stdinLines.shift();
        try {
          const parsed = JSON.parse(line);
          if (structuralMatch(parsed, frame.match)) {
            matched = true;
          }
          // Non-matching lines are consumed and discarded
        } catch {
          // Invalid JSON — skip
        }
      }
      break;
    }

    case "exit":
      if (frame.signal) {
        // Self-signal: flush stdout first so the harness can read all emitted data.
        await new Promise((resolve) => process.stdout.write("", resolve));
        process.kill(process.pid, frame.signal);
        // Wait a bit for the signal to arrive
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        // Drain stdout before exiting — process.exit() may lose buffered writes.
        await new Promise((resolve) => process.stdout.write("", resolve));
        process.exit(frame.code ?? 0);
      }
      break;

    default:
      process.stderr.write(`acp-agent.mjs: unknown frame kind: ${frame.kind}\n`);
      break;
  }
}

// If we get here without an exit frame, exit cleanly
process.exit(0);
