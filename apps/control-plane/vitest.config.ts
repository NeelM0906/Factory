import { defineConfig, mergeConfig } from "vitest/config";

import sharedConfig from "../../vitest.config.js";

// `local-execution-state.test.ts` drives a real SQLite store per case, and several cases run
// 5.2-7.4s against the 5s default when the full monorepo suite runs alongside (measured after the
// model-router fold took `turbo run test` to 23 parallel tasks; a varying subset of 4-8 cases
// timed out on successive runs, and all 210 pass on an idle machine). That is the same
// "a different test fails on each run" load signature packages/runner-local/vitest.config.ts
// documents with full measurements: contention adds rare extreme outliers to near-the-line cases
// rather than stretching the suite evenly. Same remedy, same budget: 15s matches that package and
// still catches a runaway hang three times slower than before. Parallelism is untouched — this
// suite's pressure is timer/SQLite-bound, not machine-wide PTY pressure.
export default mergeConfig(sharedConfig, defineConfig({ test: { testTimeout: 15_000 } }));
