#!/usr/bin/env node

/**
 * Fixture Codex app-server: replays a transcript file's frames over real stdio.
 *
 * Usage: node codex-agent.mjs <transcript-name>
 *
 * For each frame in the transcript:
 * - "emit": writes the JSON value to stdout as a line
 * - "emitStderr": writes the text to stderr
 * - "awaitStdin": reads one line from stdin matching frame.match
 * - "exit": exits with the given code/signal
 *
 * This script speaks the Codex app-server JSON-RPC protocol. Inbound messages
 * from the harness are standard JSON-RPC 2.0 (with `jsonrpc: "2.0"`).
 * Outbound responses carry NO `jsonrpc` member — matching the real Codex wire.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));

const transcriptName = process.argv[2];
if (!transcriptName) {
  process.stderr.write("Usage: codex-agent.mjs <transcript-name>\n");
  process.exit(2);
}

const transcriptPath = resolve(__dirname, "transcripts", `${transcriptName}.json`);
const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));

// Read stdin line by line for awaitStdin frames
const rl = createInterface({ input: process.stdin });
const stdinLines = [];
let stdinResolve = null;

rl.on("line", (line) => {
  stdinLines.push(line);
  if (stdinResolve) {
    const r = stdinResolve;
    stdinResolve = null;
    r();
  }
});

const waitForStdinLine = () => {
  if (stdinLines.length > 0) return Promise.resolve();
  return new Promise((resolve) => {
    stdinResolve = resolve;
  });
};

const writeStdout = (data) => {
  return new Promise((resolve) => {
    process.stdout.write(data, resolve);
  });
};

const writeStderr = (data) => {
  return new Promise((resolve) => {
    process.stderr.write(data, resolve);
  });
};

// Process frames
for (const frame of transcript.frames) {
  switch (frame.kind) {
    case "emit": {
      await writeStdout(JSON.stringify(frame.value) + "\n");
      break;
    }

    case "emitStderr": {
      await writeStderr(frame.text);
      break;
    }

    case "awaitStdin": {
      // Wait for a matching line on stdin
      await waitForStdinLine();
      // Consume the line (we don't validate the match in the fixture)
      stdinLines.shift();
      break;
    }

    case "exit": {
      if (frame.signal) {
        await new Promise((resolve) => process.stdout.write("", resolve));
        process.kill(process.pid, frame.signal);
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        await new Promise((resolve) => process.stdout.write("", resolve));
        process.exit(frame.code ?? 0);
      }
      break;
    }
  }
}

// If no exit frame, exit 0
await new Promise((resolve) => process.stdout.write("", resolve));
process.exit(0);
