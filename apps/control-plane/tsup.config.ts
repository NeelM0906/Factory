import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  sourcemap: true,
  clean: true,
  removeNodeProtocol: false,
  noExternal: ["@autostack/contracts", "@autostack/domain", "@autostack/db", "@autostack/workflow"]
});
