/**
 * A fixture child for quiesce honesty tests.
 *
 * Modes:
 *   "macrotask-emit"  — emits a frame via setTimeout (macrotask), then exits.
 *                        A quiesce that only awaits microtasks misses this.
 *   "poll-phase-emit" — emits a frame via a mechanism that lands on the poll phase
 *                        of the event loop (net socket write-back). A quiesce that
 *                        uses only setImmediate (check phase) misses the poll-phase read.
 *   "delayed-burst"   — waits, then emits a burst of N+1 frames where N is a constant
 *                        a fixed-turn quiesce would use, then exits. Catches a quiesce
 *                        that loops a fixed number of turns.
 */

import { createServer, createConnection } from "node:net";

const mode = process.argv[2] || "macrotask-emit";

const write = (obj) => {
  process.stdout.write(JSON.stringify(obj) + "\n");
};

switch (mode) {
  case "macrotask-emit": {
    // Emit after a macrotask (setTimeout). A microtask-only quiesce will miss this
    // because setTimeout fires in the timers phase, and the stdout write lands
    // bytes on the poll phase.
    setTimeout(() => {
      write({ type: "data", source: "macrotask" });
      process.exit(0);
    }, 30);
    break;
  }

  case "poll-phase-emit": {
    // Use a loopback socket to force a poll-phase callback. The data arrives as
    // a readable event on a socket, which is serviced during the poll phase —
    // a setImmediate-only drain loop (check phase) would return before this.
    const server = createServer((socket) => {
      socket.on("data", () => {
        write({ type: "data", source: "poll-phase" });
        socket.end();
        server.close();
        process.exit(0);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      const client = createConnection({ port, host: "127.0.0.1" }, () => {
        client.write("trigger");
        client.end();
      });
    });
    break;
  }

  case "delayed-burst": {
    // Wait a bit, then emit more frames than any small fixed-turn constant.
    setTimeout(() => {
      for (let i = 0; i < 10; i++) {
        write({ type: "burst", seq: i + 1 });
      }
      process.exit(0);
    }, 50);
    break;
  }

  default:
    process.stderr.write(`Unknown quiesce mode: ${mode}\n`);
    process.exit(2);
}
