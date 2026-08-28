import { defineConfig, mergeConfig } from "vitest/config";

import sharedConfig from "../../vitest.config.js";

// This suite drives real PTYs, real child processes and real filesystem state. Those are
// machine-wide resources, not per-worker ones, so running its files across a fork per core
// oversubscribes the box: under `turbo run test` (up to 10 packages at once) the guardian and
// conformance teardowns miss their bounded settle budgets and a different test fails on each run.
// Running this package's files one at a time keeps PTY/subprocess pressure to a single file's
// worth. Measured cost: ~105s -> ~273s for this package. A bounded forks pool (maxForks: 3) was
// tried first and was much cheaper (~109s) but still failed, so the bound has to be one file.
// Scoped to this package on purpose — the rest of the monorepo parallelises fine.
//
// `testTimeout` is raised for the same reason and on the same evidence. Measured across all 853
// cases, idle machine versus a real `turbo run test --force` alongside the other twenty tasks:
//
//   - 8 cases already run at 3.0-3.9s on an IDLE machine, against the 5s default. The slowest,
//     conformance's "rejects tampered command authorization…", is 3940ms — 79% of the budget spent
//     before anything goes wrong, and before CI adds V8 coverage instrumentation on top.
//   - Contention does not stretch the suite evenly: the median stretch over the 85 slowest cases is
//     1.06x and p90 is 1.26x. What it adds is the occasional extreme outlier — command-executor's
//     "reserves before worktree lookup…" went 818ms -> 5022ms, 6.1x, and timed out. Cases that
//     spawn real subprocesses and PTYs are hostage to whole-machine spawn latency, which is not
//     proportional to CPU load.
//
// So the failure is not any one case's fault. A near-the-line case plus one outlier is a lost
// lottery, which is exactly the "a different test fails on each run" recorded above: this flake was
// reported against artifact-store's blob range case and reproduced here as a command-executor case.
// Pinning whichever case lost last would move the failure, not remove it, and the 3940ms case is
// the next one due — its neighbour was pinned in 02e5cff for timing out at 5s under CI coverage.
//
// 15s matches the per-case pins this package already carries and leaves 3.8x over the worst idle
// case. Those pins are kept rather than folded in: they record why those specific cases are slow,
// and they still bind if this default is ever lowered. The 60s and 120s replay-spool pins are
// unaffected. A runaway hang is still caught, three times slower than before.
export default mergeConfig(
  sharedConfig,
  defineConfig({ test: { fileParallelism: false, testTimeout: 15_000 } })
);
