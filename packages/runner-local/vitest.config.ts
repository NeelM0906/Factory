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
export default mergeConfig(sharedConfig, defineConfig({ test: { fileParallelism: false } }));
