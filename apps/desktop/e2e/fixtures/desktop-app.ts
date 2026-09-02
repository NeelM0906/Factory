import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { redactSensitiveText } from "@autostack/contracts";
import { expect, type TestInfo } from "@playwright/test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

import type { TestRepositoryScenario } from "./test-repository.js";

const desktop = resolve(import.meta.dirname, "..");
const verifierEntry = join(desktop, ".e2e-dist", "verifier-entry.js");

export const launch = async (
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
      .split("\n")
      .map((line) =>
        redactSensitiveText(
          line.replaceAll(scenario.token, "<redacted>").replaceAll(scenario.root, "<scenario>")
        )
      )
      .join("\n");
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

export const attachScreenshot = async (
  page: Page,
  testInfo: TestInfo,
  name: string
): Promise<void> => {
  const body = await page.screenshot({ fullPage: true });
  await testInfo.attach(name, { body, contentType: "image/png" });
};

export const quitAndWait = async (application: ElectronApplication): Promise<void> => {
  const process = application.process();
  await application.evaluate(() =>
    (globalThis as unknown as { __autostackVerifier: { quit(): void } }).__autostackVerifier.quit()
  );
  await expect
    .poll(() => process.exitCode !== null || process.signalCode !== null, { timeout: 10_000 })
    .toBe(true);
  await application.close().catch(() => undefined);
};

export const assertAccessible = async (page: Page): Promise<void> => {
  const result = await new AxeBuilder({ page }).setLegacyMode().analyze();
  expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
};
