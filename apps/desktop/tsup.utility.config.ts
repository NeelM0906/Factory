import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/utility/host.ts", "src/utility/control-plane.ts"],
  format: ["esm"],
  outDir: "dist/utility",
  removeNodeProtocol: false,
  external: ["electron", "node-pty"],
  noExternal: [/^@autostack\//]
});
