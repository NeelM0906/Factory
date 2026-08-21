import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: [
        "**/dist/**",
        "**/coverage/**",
        "**/*.config.{js,mjs,cjs,ts}",
        "**/*.d.ts",
        "**/test/**"
      ],
      provider: "v8",
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80
      }
    },
    include: ["**/*.test.ts", "**/*.test.tsx"]
  }
});
