import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/utility-entry.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  sourcemap: true,
  clean: true,
  noExternal: ["@autostack/contracts", "@autostack/domain", "@autostack/runner-local"],
  external: ["electron", "node-pty"]
});
