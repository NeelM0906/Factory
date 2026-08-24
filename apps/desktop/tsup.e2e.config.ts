import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["e2e/fixtures/verifier-entry.ts", "e2e/fixtures/quick-exit-probe.ts"],
  format: ["esm"],
  outDir: ".e2e-dist",
  external: ["electron", "node-pty"],
  noExternal: [/^@autostack\//],
  clean: true,
  sourcemap: false,
  dts: false,
  splitting: true,
  target: "es2023",
  removeNodeProtocol: false
});
