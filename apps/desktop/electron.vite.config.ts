import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@autostack/contracts"] })],
    build: { outDir: "dist/main", rollupOptions: { input: "src/main/index.ts" } }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@autostack/contracts"] })],
    build: {
      outDir: "dist/preload",
      rollupOptions: {
        input: "src/preload/index.ts",
        output: { format: "cjs", entryFileNames: "index.cjs" }
      }
    }
  },
  renderer: {
    root: "src/renderer",
    plugins: [react()],
    server: { host: "127.0.0.1" },
    build: { outDir: resolve(import.meta.dirname, "dist/renderer"), emptyOutDir: true }
  }
});
