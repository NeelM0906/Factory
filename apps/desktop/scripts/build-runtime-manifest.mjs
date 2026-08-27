import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath, rename, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const packageRoot = resolve(import.meta.dirname, "..");
const desktopBuildRoot = await realpath(join(packageRoot, "dist"));
const electronExecutable = await realpath(require("electron"));
const guardianModule = await realpath(join(desktopBuildRoot, "guardian", "index.js"));
const nativeDirectory = await realpath(join(desktopBuildRoot, "runtime", "native"));
const electronPackage = require("electron/package.json");
const nodePtyPackage = require("node-pty/package.json");

const assertIdentity = async (path, kind) => {
  const link = await lstat(path);
  const metadata = await stat(path);
  if (
    link.isSymbolicLink() ||
    (kind === "file" ? !metadata.isFile() : !metadata.isDirectory()) ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new TypeError(`unsafe runtime ${kind}`);
  }
};

if (electronPackage.version !== "43.4.0" || nodePtyPackage.version !== "1.1.0") {
  throw new TypeError("runtime dependency version mismatch");
}
await Promise.all([
  assertIdentity(desktopBuildRoot, "directory"),
  assertIdentity(electronExecutable, "file"),
  assertIdentity(guardianModule, "file"),
  assertIdentity(nativeDirectory, "directory")
]);

// Version equality above says nothing about the staged binary's ABI. The guardian loads the staged
// node-pty from inside Electron -- forked with `execPath: electronExecutable` and
// `ELECTRON_RUN_AS_NODE=1` (apps/desktop/src/utility/host.ts:92-98) -- and Electron 43.4.0 reports
// NODE_MODULE_VERSION 148 while the Node that runs this script reports its own (137 on CI's Node
// 24). If `rebuild-native.mjs` ever stages a Node-ABI prebuild instead of an Electron-ABI build,
// nothing notices until a command runs, inside a child forked with its stdio discarded. So load it
// here, under the exact binary and mode that will load it in production, and fail the build
// instead.
const stagedNodePty = join(nativeDirectory, "node_modules", "node-pty");
const probe = spawnSync(
  electronExecutable,
  [
    "-e",
    `require(${JSON.stringify(stagedNodePty)});process.stdout.write(process.versions.modules);`
  ],
  {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    timeout: 60_000
  }
);
if (probe.status !== 0 || probe.stdout.length === 0) {
  throw new TypeError(
    `staged native runtime does not load under Electron ${electronPackage.version}: ${
      probe.stderr.trim() || probe.stdout.trim() || "no output"
    }`
  );
}

const manifest = `${JSON.stringify({
  schemaVersion: 1,
  electronExecutable,
  guardianModule,
  nativeDirectory,
  desktopBuildRoot,
  electronVersion: "43.4.0",
  nodePtyVersion: "1.1.0"
})}\n`;
const digest = createHash("sha256").update(manifest).digest("hex");

const publish = async (name, value) => {
  const target = join(desktopBuildRoot, name);
  const temporary = join(desktopBuildRoot, `.${name}.${randomUUID()}.tmp`);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o600);
  await rename(temporary, target);
};

await publish("runtime-manifest.json", manifest);
await publish("runtime-manifest.sha256", `${digest}\n`);
