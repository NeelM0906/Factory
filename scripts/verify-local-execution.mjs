import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import {
  assertScenarioUnchanged,
  createTestRepositoryScenario
} from "../apps/desktop/e2e/fixtures/test-repository.ts";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(workspace, "apps", "desktop");
const desktopRequire = createRequire(join(desktop, "package.json"));
const { _electron: electron } = desktopRequire("playwright");
const verifierEntry = join(desktop, ".e2e-dist", "verifier-entry.js");
const secretFree = (value, secrets) => {
  for (const secret of secrets) {
    if (secret.length > 0 && value.includes(secret))
      throw new Error("sensitive verifier value leaked");
  }
};

const build = spawnSync(
  "pnpm",
  [
    "--filter",
    "@autostack/desktop",
    "exec",
    "tsup",
    "--config",
    "tsup.e2e.config.ts"
  ],
  { cwd: workspace, encoding: "utf8" }
);
if (build.status !== 0) throw new Error(build.stderr || build.stdout || "verifier build failed");

const workspacePolicy = await readFile(join(workspace, "pnpm-workspace.yaml"), "utf8");
const builtDependencies = [...workspacePolicy.matchAll(/^  - ([a-z0-9-]+)$/gm)].map(
  (match) => match[1]
);
if (JSON.stringify(builtDependencies) !== JSON.stringify(["electron", "node-pty"])) {
  throw new Error("unexpected lifecycle-script allowlist");
}
const e2eSource = await readFile(join(desktop, "e2e", "local-execution.spec.ts"), "utf8");
if (/\b(?:test|it|describe)\.(?:skip|fixme|fail|only)\b/.test(e2eSource)) {
  throw new Error("focused or disabled E2E test detected");
}

const manifestPath = join(desktop, "dist", "runtime-manifest.json");
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
if (manifest.schemaVersion !== 1 || manifest.electronVersion !== "43.4.0") {
  throw new Error("invalid desktop runtime manifest");
}
await Promise.all(
  [
    manifest.electronExecutable,
    manifest.guardianModule,
    manifest.nativeDirectory,
    join(desktop, "dist", "main", "index.js"),
    verifierEntry
  ].map(async (path) => await access(path))
);
const runtimeSources = await Promise.all(
  [
    join(desktop, "dist", "main", "index.js"),
    join(desktop, "dist", "preload", "index.cjs"),
    join(desktop, "dist", "guardian", "index.js"),
    join(desktop, "dist", "utility", "host.js"),
    join(desktop, "dist", "utility", "control-plane.js")
  ].map(async (path) => await readFile(path, "utf8"))
);
if (
  runtimeSources.some((source) =>
    /from ["']@autostack\/|from ["']sqlite["']|packages\/.+\/src\/.+\.(?:js|ts)["']/.test(source)
  )
) {
  throw new Error("built desktop contains an unresolved workspace runtime import");
}
const expectedDigest = (
  await readFile(join(desktop, "dist", "runtime-manifest.sha256"), "utf8")
).trim();
if (createHash("sha256").update(manifestBytes).digest("hex") !== expectedDigest) {
  throw new Error("desktop runtime manifest digest mismatch");
}

const scenario = await createTestRepositoryScenario();
let application;
try {
  application = await electron.launch({
    executablePath: manifest.electronExecutable,
    args: [verifierEntry],
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: process.env.HOME ?? dirname(scenario.root),
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      AUTOSTACK_E2E_DESCRIPTOR: scenario.descriptor
    },
    timeout: 30_000
  });
  const page = await application.firstWindow({ timeout: 30_000 });
  await page.getByRole("heading", { name: "AutoStack Factory" }).waitFor({ timeout: 30_000 });
  await page.waitForFunction(
    async () => (await window.autostack.runtimeStatus()).status === "ready",
    undefined,
    { timeout: 30_000 }
  );
  const renderer = await page.evaluate(async () => ({
    text: document.body.innerText,
    html: document.documentElement.outerHTML,
    globals: {
      process: typeof globalThis.process,
      require: typeof globalThis.require,
      Buffer: typeof globalThis.Buffer,
      module: typeof globalThis.module,
      ipcRenderer: typeof globalThis.ipcRenderer
    },
    bridgeKeys: Object.keys(window.autostack).sort(),
    bridgeFrozen: Object.isFrozen(window.autostack),
    runtime: await window.autostack.runtimeStatus(),
    health: await window.autostack.request({ operation: "factory.health" }),
    runs: await window.autostack.request({ operation: "factory.runs.list" })
  }));
  if (
    renderer.runtime.status !== "ready" ||
    renderer.health.status !== "ok" ||
    !renderer.bridgeFrozen ||
    JSON.stringify(renderer.bridgeKeys) !==
      JSON.stringify([
        "pickRepository",
        "request",
        "runtimeStatus",
        "subscribeCommand",
        "subscribeRuntimeStatus"
      ]) ||
    Object.values(renderer.globals).some((value) => value !== "undefined")
  ) {
    throw new Error("renderer isolation or typed bridge verification failed");
  }
  const picked = await page.evaluate(async () => await window.autostack.pickRepository());
  if (
    typeof picked.id !== "string" ||
    picked.label !== "source" ||
    JSON.stringify(picked).includes(scenario.source)
  ) {
    throw new Error("repository capability exposed path authority");
  }
  const audit = await application.evaluate(() => globalThis.__autostackVerifier.audit());
  if (
    audit.windowCount !== 1 ||
    !audit.hostActive ||
    !audit.controlPlaneActive ||
    audit.preferences.sandbox !== true ||
    audit.preferences.contextIsolation !== true ||
    audit.preferences.nodeIntegration !== false ||
    audit.preferences.webSecurity !== true
  ) {
    throw new Error("effective Electron security configuration failed");
  }
  const combinedRenderer = `${renderer.text}\n${renderer.html}\n${JSON.stringify(renderer.runs)}`;
  secretFree(combinedRenderer, [scenario.token, scenario.source, scenario.userData]);
  await assertScenarioUnchanged(scenario);
  await application.evaluate(() => globalThis.__autostackVerifier.quit());
  await application.close();
  application = undefined;
  await assertScenarioUnchanged(scenario);
  const rootMetadata = await stat(scenario.root);
  if ((rootMetadata.mode & 0o077) !== 0) throw new Error("verifier root is not private");
  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      runtime: "electron",
      sourceCheckout: "unchanged",
      repositoryCapability: "opaque",
      rendererIsolation: "verified",
      runtimeManifestDigest: expectedDigest,
      runCount: renderer.runs.items.length
    })}\n`
  );
} finally {
  if (application !== undefined) await application.close().catch(() => undefined);
  await scenario.cleanup();
}
