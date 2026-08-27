import { defineConfig, mergeConfig } from "vitest/config";

import sharedConfig from "../../vitest.config.js";

// Same reasoning as `packages/runner-local/vitest.config.ts`: this suite spawns real child
// processes, which are a machine-wide resource rather than a per-worker one. Running its files
// across a fork per core oversubscribes the box under `turbo run test`, and the first thing to
// suffer is exactly what this package exists to get right -- the bounded settle budgets behind
// `quiesce()` and the process-group teardowns. One file at a time keeps subprocess pressure to a
// single file's worth.
export default mergeConfig(sharedConfig, defineConfig({ test: { fileParallelism: false } }));
