import { defineConfig, mergeConfig } from "vitest/config";

import sharedConfig from "../../vitest.config.js";

// Same reasoning as `packages/runner-local/vitest.config.ts`: this suite spawns real child
// processes, which are a machine-wide resource rather than a per-worker one. Running its files
// across a fork per core oversubscribes the box under `turbo run test`, and the first thing to
// suffer is exactly what this package exists to get right -- the bounded settle budgets behind
// `quiesce()` and the process-group teardowns. One file at a time keeps subprocess pressure to a
// single file's worth.
//
// `testTimeout` is raised on the same evidence, adopted from that package's 0.13 re-budget rather
// than re-measured here. The finding that transfers: contention does not stretch a subprocess suite
// evenly -- its median stretch was 1.06x and p90 1.26x -- but it produces occasional extreme
// outliers, one case going 818ms -> 5022ms (6.1x) and timing out, because a case that spawns a real
// child is hostage to whole-machine spawn latency, which is not proportional to CPU load.
//
// This package has exactly that profile and then some: conformance spawns a real fixture child per
// subject, across two runners, with the pause and permission behaviours repeated twenty times. A
// budget calibrated on an idle machine would make those repeats a lottery, and the failure would
// land on whichever case lost rather than on whatever is actually wrong. 15s matches the reference
// package so the two do not drift apart; a runaway hang is still caught.
export default mergeConfig(
  sharedConfig,
  defineConfig({ test: { fileParallelism: false, testTimeout: 15_000 } })
);
