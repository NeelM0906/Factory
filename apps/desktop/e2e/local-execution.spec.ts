import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type TestInfo } from "@playwright/test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

import {
  assertScenarioUnchanged,
  createTestRepositoryScenario,
  type TestRepositoryScenario
} from "./fixtures/test-repository.js";
import { seedApprovedExecution } from "./fixtures/seed-execution.js";

const desktop = resolve(import.meta.dirname, "..");
const workspace = resolve(desktop, "../..");
const verifierEntry = join(desktop, ".e2e-dist", "verifier-entry.js");
const quickExitProbe = join(desktop, ".e2e-dist", "quick-exit-probe.js");
const disclosure =
  "Local commands run with your desktop user's host filesystem and network authority. AutoStack path checks protect AutoStack operations; they are not an operating-system sandbox.";

const buildVerifier = (): void => {
  const result = spawnSync(
    "pnpm",
    ["--filter", "@autostack/desktop", "exec", "tsup", "--config", "tsup.e2e.config.ts"],
    { cwd: workspace, encoding: "utf8" }
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
};

const launch = async (
  scenario: TestRepositoryScenario
): Promise<{
  readonly application: ElectronApplication;
  readonly page: Page;
}> => {
  const manifest = JSON.parse(
    await readFile(join(desktop, "dist", "runtime-manifest.json"), "utf8")
  ) as { readonly electronExecutable: string };
  const application = await electron.launch({
    executablePath: manifest.electronExecutable,
    args: [`--user-data-dir=${scenario.userData}`, verifierEntry],
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: process.env.HOME ?? "/tmp",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      AUTOSTACK_E2E_DESCRIPTOR: await scenario.writeDescriptor()
    },
    timeout: 30_000
  });
  const errors: Buffer[] = [];
  application.process().stderr?.on("data", (chunk: Buffer) => errors.push(chunk));
  let page: Page;
  try {
    page = await application.firstWindow({ timeout: 30_000 });
  } catch (error) {
    const sanitized = Buffer.concat(errors)
      .toString("utf8")
      .replaceAll(scenario.token, "<redacted>")
      .replaceAll(scenario.root, "<scenario>");
    throw new Error(`desktop launch closed: ${sanitized || String(error)}`);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("heading", { name: "AutoStack Factory" }).waitFor();
  await expect
    .poll(
      async () => await page.evaluate(async () => (await window.autostack.runtimeStatus()).status)
    )
    .toBe("ready");
  return { application, page };
};

const attachScreenshot = async (page: Page, testInfo: TestInfo, name: string): Promise<void> => {
  const body = await page.screenshot({ fullPage: true });
  await testInfo.attach(name, { body, contentType: "image/png" });
};

const quitAndWait = async (application: ElectronApplication): Promise<void> => {
  const process = application.process();
  await application.evaluate(() =>
    (globalThis as unknown as { __autostackVerifier: { quit(): void } }).__autostackVerifier.quit()
  );
  await expect
    .poll(() => process.exitCode !== null || process.signalCode !== null, { timeout: 10_000 })
    .toBe(true);
  await application.close().catch(() => undefined);
};

const assertAccessible = async (page: Page): Promise<void> => {
  const result = await new AxeBuilder({ page }).setLegacyMode().analyze();
  expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
};

test("real desktop survives restart and keeps repository authority opaque", async ({}, testInfo) => {
  buildVerifier();
  const manifest = JSON.parse(
    await readFile(join(desktop, "dist", "runtime-manifest.json"), "utf8")
  ) as { readonly electronExecutable: string };
  const quickExit = spawnSync(manifest.electronExecutable, [quickExitProbe], {
    cwd: desktop,
    encoding: "utf8",
    timeout: 5_000,
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: process.env.HOME ?? "/tmp",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      ELECTRON_RUN_AS_NODE: "1"
    }
  });
  expect(quickExit.status, quickExit.stderr || quickExit.stdout).toBe(0);
  expect(JSON.parse(quickExit.stdout.trim())).toMatchObject({ status: "passed" });
  const scenario = await createTestRepositoryScenario();
  const seeded = await seedApprovedExecution(scenario);
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(scenario);
    application = launched.application;
    let page = launched.page;

    await expect(page.getByRole("alert")).toHaveText(disclosure);
    await assertAccessible(page);
    await attachScreenshot(page, testInfo, "factory-default.png");

    const selected = await page.evaluate(async () => await window.autostack.pickRepository());
    expect(selected.id).toMatch(/^repocap_[0-9a-f-]{36}$/);
    expect(selected.label).toBe("source");
    expect(JSON.stringify(selected)).not.toContain(scenario.source);
    await attachScreenshot(page, testInfo, "capability-disclosure.png");
    expect(
      await application.evaluate(() =>
        (
          globalThis as unknown as {
            __autostackVerifier: {
              diagnoseHostInspection(): Promise<{
                status: number;
                code: string;
                contentType: string;
              }>;
            };
          }
        ).__autostackVerifier.diagnoseHostInspection()
      )
    ).toEqual({ status: 200, code: "ok", contentType: "application/json" });
    expect(
      await application.evaluate(() =>
        (
          globalThis as unknown as {
            __autostackVerifier: { diagnoseHostClientInspection(): Promise<string> };
          }
        ).__autostackVerifier.diagnoseHostClientInspection()
      )
    ).toBe("ok");

    const inspected = await page
      .evaluate(
        async ({ repositoryCapabilityId, branchSlug }) =>
          await window.autostack.request<"local.inspect">({
            operation: "local.inspect",
            repositoryCapabilityId,
            baseRef: "main",
            branchSlug
          }),
        { repositoryCapabilityId: selected.id, branchSlug: seeded.branchSlug }
      )
      .catch(async (error: unknown) => {
        const trace = await application!.evaluate(() =>
          (
            globalThis as unknown as {
              __autostackVerifier: { messageTrace(): string[] };
            }
          ).__autostackVerifier.messageTrace()
        );
        throw new Error(`local.inspect failed (${trace.join(",")}): ${String(error)}`);
      });
    const execution = await page.evaluate(
      async ({ inspectedSourceCapabilityId, seed }) => {
        let prepared;
        try {
          prepared = await window.autostack.request<"local.prepare">({
            operation: "local.prepare",
            runId: seed.runId,
            environmentId: seed.environmentId,
            environmentAuthorizationId: seed.environmentAuthorizationId,
            inspectedSourceCapabilityId,
            idempotencyKey: "task10-prepare"
          });
        } catch (error) {
          throw new Error(`local.prepare failed: ${String(error)}`);
        }
        const accepted = await window.autostack
          .request<"local.start">({
            operation: "local.start",
            runId: seed.runId,
            environmentId: seed.environmentId,
            commandId: seed.commandId,
            commandAuthorizationId: seed.commandAuthorizationId,
            command: seed.command,
            idempotencyKey: "task10-start"
          })
          .catch((error: unknown) => {
            throw new Error(`local.start failed: ${String(error)}`);
          });
        const durableTypes: string[] = [];
        const durableDeadline = Date.now() + 5_000;
        while (Date.now() < durableDeadline) {
          const page = await window.autostack.request<"factory.runs.events">({
            operation: "factory.runs.events",
            runId: seed.runId,
            after: 0
          });
          durableTypes.splice(0, durableTypes.length, ...page.events.map((event) => event.type));
          if (durableTypes.includes("command.started")) break;
          await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
        }
        if (!durableTypes.includes("command.started")) {
          const environments = await window.autostack.request<"local.list">({
            operation: "local.list"
          });
          throw new Error(
            `durable command start timed out: ${durableTypes.join(",")}; environments=${JSON.stringify(environments)}`
          );
        }
        const events = await new Promise<unknown[]>((resolveEvents, rejectEvents) => {
          const collected: unknown[] = [];
          const timeout = setTimeout(() => {
            detach();
            rejectEvents(
              new Error(
                `command stream timed out: ${collected
                  .map((event) =>
                    event !== null && typeof event === "object" && "type" in event
                      ? String(event.type)
                      : "unknown"
                  )
                  .join(",")}`
              )
            );
          }, 30_000);
          const detach = window.autostack.subscribeCommand(
            {
              operation: "local.events",
              environmentId: seed.environmentId,
              commandId: seed.commandId,
              after: 0
            },
            (event) => {
              collected.push(event);
              if (event.type === "command.completed" || event.type === "stream.error") {
                clearTimeout(timeout);
                detach();
                resolveEvents(collected);
              }
            }
          );
        });
        const completed = events.find(
          (event) =>
            event !== null &&
            typeof event === "object" &&
            "type" in event &&
            event.type === "command.completed"
        ) as { transcript: { artifactId: string; byteSize: number } } | undefined;
        if (completed === undefined) throw new Error("command did not complete");
        const reconciliationDeadline = Date.now() + 10_000;
        let reconciledTypes: string[] = [];
        while (Date.now() < reconciliationDeadline) {
          const page = await window.autostack.request<"factory.runs.events">({
            operation: "factory.runs.events",
            runId: seed.runId,
            after: 0
          });
          reconciledTypes = page.events.map((event) => event.type);
          if (
            reconciledTypes.includes("artifact.recorded") &&
            reconciledTypes.includes("command.completed")
          ) {
            break;
          }
          await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
        }
        if (
          !reconciledTypes.includes("artifact.recorded") ||
          !reconciledTypes.includes("command.completed")
        ) {
          throw new Error(`command reconciliation timed out: ${reconciledTypes.join(",")}`);
        }
        const artifactDeadline = Date.now() + 10_000;
        let artifact;
        while (Date.now() < artifactDeadline) {
          try {
            artifact = await window.autostack.request<"local.artifact.read">({
              operation: "local.artifact.read",
              artifactId: completed.transcript.artifactId as never,
              offset: 0,
              length: Math.max(1, completed.transcript.byteSize)
            });
            break;
          } catch {
            await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
          }
        }
        if (artifact === undefined) throw new Error("local.artifact.read timed out");
        return { prepared, accepted, events, artifact };
      },
      {
        inspectedSourceCapabilityId: inspected.inspectedSourceCapabilityId,
        seed: {
          runId: seeded.runId,
          environmentId: seeded.environmentId,
          environmentAuthorizationId: seeded.environmentAuthorizationId,
          commandId: seeded.commandId,
          commandAuthorizationId: seeded.commandAuthorizationId,
          command: seeded.command,
          branchSlug: seeded.branchSlug
        }
      }
    );
    expect(execution.prepared.replayed).toBe(false);
    expect(execution.events.map((event) => (event as { type: string }).type)).toEqual(
      expect.arrayContaining([
        "command.started",
        "terminal.output",
        "artifact.created",
        "command.completed"
      ])
    );
    const transcript = Buffer.from(execution.artifact.bytes, "base64").toString("utf8");
    expect(transcript).toContain("fixture complete");
    expect(JSON.stringify(execution)).not.toContain(scenario.token);
    expect(JSON.stringify(execution)).not.toContain(scenario.source);
    await assertScenarioUnchanged(scenario);
    const created = await page.evaluate(
      async () =>
        await window.autostack.request<"factory.runs.create">({
          operation: "factory.runs.create",
          request: {
            title: "Persistent local alpha proof",
            description: "Created through the typed desktop bridge.",
            acceptanceContext: []
          },
          idempotencyKey: "task10-persistent-run"
        })
    );
    expect(created.run.id).toMatch(/^run_/);

    await application.evaluate(() =>
      (
        globalThis as unknown as {
          __autostackVerifier: { kill(service: "host" | "control-plane"): boolean };
        }
      ).__autostackVerifier.kill("host")
    );
    await expect(page.getByRole("alert", { name: /Desktop runtime recovering/i })).toBeVisible();
    await attachScreenshot(page, testInfo, "runtime-degraded.png");
    await quitAndWait(application);
    application = undefined;
    ({ application, page } = await launch(scenario));
    await expect(page.getByRole("heading", { name: "AutoStack Factory" })).toBeVisible();

    await application.evaluate(() =>
      (
        globalThis as unknown as {
          __autostackVerifier: { resize(width: number, height: number): void };
        }
      ).__autostackVerifier.resize(720, 900)
    );
    await expect.poll(async () => await page.evaluate(() => window.innerWidth)).toBe(720);
    await assertAccessible(page);
    await attachScreenshot(page, testInfo, "factory-narrow.png");

    await quitAndWait(application);
    application = undefined;

    ({ application, page } = await launch(scenario));
    const runs = await page.evaluate(
      async () =>
        await window.autostack.request<"factory.runs.list">({ operation: "factory.runs.list" })
    );
    expect(runs.items.some((run) => run.runId === created.run.id)).toBe(true);
    const audit = await application.evaluate(() =>
      (
        globalThis as unknown as {
          __autostackVerifier: {
            audit(): {
              userDataRoot: string;
              preferences: Record<string, boolean | undefined>;
            };
          };
        }
      ).__autostackVerifier.audit()
    );
    expect(audit.userDataRoot).toBe(scenario.userData);
    expect(audit.preferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    });
    expect(
      await page.evaluate(() => ({
        bridgeFrozen: Object.isFrozen(window.autostack),
        bridgeKeys: Object.keys(window.autostack).sort(),
        process: typeof globalThis.process,
        require: typeof globalThis.require,
        Buffer: typeof globalThis.Buffer
      }))
    ).toEqual({
      bridgeFrozen: true,
      bridgeKeys: [
        "pickRepository",
        "request",
        "runtimeStatus",
        "subscribeCommand",
        "subscribeRuntimeStatus"
      ],
      process: "undefined",
      require: "undefined",
      Buffer: "undefined"
    });
    await assertScenarioUnchanged(scenario);
  } finally {
    if (application !== undefined) {
      await application
        .evaluate(() =>
          (
            globalThis as unknown as { __autostackVerifier: { quit(): void } }
          ).__autostackVerifier.quit()
        )
        .catch(() => undefined);
      await application.close().catch(() => undefined);
    }
    await scenario.cleanup();
  }
});
