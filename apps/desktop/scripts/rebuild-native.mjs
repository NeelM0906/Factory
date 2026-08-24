import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";

import { rebuild } from "@electron/rebuild";

const require = createRequire(import.meta.url);
const packageRoot = resolve(import.meta.dirname, "..");
const stagingRoot = join(packageRoot, "dist", "runtime", "native");
const buildRoot = await mkdtemp(join(tmpdir(), "autostack-electron-native-"));
const source = dirname(require.resolve("node-pty/package.json"));
const nodePtyRequire = createRequire(join(source, "package.json"));
const nodeAddonApiSource = dirname(nodePtyRequire.resolve("node-addon-api/package.json"));
const target = join(buildRoot, "node_modules", "node-pty");

try {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(
    join(buildRoot, "package.json"),
    `${JSON.stringify({ private: true, dependencies: { "node-pty": "1.1.0" } })}\n`,
    { mode: 0o600 }
  );
  await cp(source, target, { recursive: true, dereference: false, errorOnExist: true });
  await cp(nodeAddonApiSource, join(buildRoot, "node_modules", "node-addon-api"), {
    recursive: true,
    dereference: false,
    errorOnExist: true
  });
  process.env.npm_config_devdir = join(buildRoot, ".electron-gyp");
  await rebuild({
    buildPath: buildRoot,
    electronVersion: "43.4.0",
    onlyModules: ["node-pty"],
    force: true
  });
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(dirname(stagingRoot), { recursive: true, mode: 0o700 });
  await cp(buildRoot, stagingRoot, { recursive: true, dereference: false, errorOnExist: true });
} finally {
  delete process.env.npm_config_devdir;
  await rm(buildRoot, { recursive: true, force: true });
}
