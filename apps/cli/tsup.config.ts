import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  platform: "node",
  sourcemap: true,
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
  noExternal: ["@autostack/contracts"]
});
