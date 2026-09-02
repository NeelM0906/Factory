/**
 * A fixture child process that simulates an agent session over line-delimited stdio.
 *
 * Modes (passed as argv[2]):
 *   "echo"    — reads lines from stdin and echoes them as JSON frames on stdout
 *   "emit"    — immediately emits N frames (argv[3]) on stdout then exits
 *   "stderr"  — writes a line to stderr then a frame to stdout then exits
 *   "hang"    — emits one frame, then blocks forever (for timeout testing)
 *   "silent"  — does nothing, blocks forever (for progress-timeout testing)
 *   "slow"    — emits one frame every 200ms for N frames (argv[3])
 *   "exit"    — exits with code argv[3] immediately
 *   "signal"  — emits one frame, then ignores SIGTERM, forcing SIGKILL
 *   "env"     — dumps the environment to stdout as JSON and exits
 *   "spawn-info" — dumps spawn information (ppid, env keys) and blocks
 */

import { createInterface } from "node:readline";

const mode = process.argv[2] || "echo";
const arg = process.argv[3];

const write = (obj) => {
  process.stdout.write(JSON.stringify(obj) + "\n");
};

switch (mode) {
  case "echo": {
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      try {
        const parsed = JSON.parse(line);
        write({ echoed: parsed });
      } catch {
        write({ error: "invalid_json" });
      }
    });
    rl.on("close", () => process.exit(0));
    break;
  }

  case "emit": {
    const count = parseInt(arg || "3", 10);
    for (let i = 0; i < count; i++) {
      write({ seq: i + 1, type: "data" });
    }
    process.exit(0);
    break;
  }

  case "stderr": {
    process.stderr.write("diagnostic: something happened\n");
    write({ type: "result", ok: true });
    process.exit(0);
    break;
  }

  case "hang": {
    write({ type: "init", status: "ready" });
    // Block indefinitely — the supervisor must terminate us.
    setInterval(() => {}, 60_000);
    break;
  }

  case "silent": {
    // Do nothing. Block forever.
    setInterval(() => {}, 60_000);
    break;
  }

  case "slow": {
    const count = parseInt(arg || "5", 10);
    let emitted = 0;
    const interval = setInterval(() => {
      emitted++;
      write({ seq: emitted, type: "data" });
      if (emitted >= count) {
        clearInterval(interval);
        process.exit(0);
      }
    }, 200);
    break;
  }

  case "exit": {
    process.exit(parseInt(arg || "1", 10));
    break;
  }

  case "signal": {
    write({ type: "init", status: "ready" });
    // Ignore SIGTERM to force SIGKILL escalation.
    process.on("SIGTERM", () => {
      // deliberately ignored
    });
    setInterval(() => {}, 60_000);
    break;
  }

  case "env": {
    write({ env: Object.keys(process.env).sort() });
    process.exit(0);
    break;
  }

  case "spawn-info": {
    write({
      ppid: process.ppid,
      pid: process.pid,
      envKeys: Object.keys(process.env).sort(),
      stdio: [
        process.stdin.fd !== undefined,
        process.stdout.fd !== undefined,
        process.stderr.fd !== undefined
      ]
    });
    // Stay alive for inspection
    setInterval(() => {}, 60_000);
    break;
  }

  default:
    process.stderr.write(`Unknown mode: ${mode}\n`);
    process.exit(2);
}
