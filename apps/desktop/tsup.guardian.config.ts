import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/guardian/index.ts"],
  format: ["esm"],
  outDir: "dist/guardian",
  external: ["electron", "node-pty"],
  noExternal: [/^@autostack\//],
  clean: true,
  sourcemap: false,
  dts: false,
  splitting: true,
  target: "es2023",
  removeNodeProtocol: false
});
