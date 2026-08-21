import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  platform: "node",
  sourcemap: true,
  clean: true,
  noExternal: ["@autostack/contracts", "@autostack/domain", "@autostack/db", "@autostack/workflow"]
});
