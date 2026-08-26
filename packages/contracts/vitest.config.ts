import { defineConfig, mergeConfig } from "vitest/config";

import sharedConfig from "../../vitest.config.js";

export default mergeConfig(
  sharedConfig,
  defineConfig({
    // Local-execution evidence coherence tests are crypto-digest bound and run 2-5s of real
    // hashing; the 5s default leaves no margin once the suite runs its files in parallel.
    test: { testTimeout: 20_000 }
  })
);
