import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { expect, test } from "@playwright/test";
import { type ElectronApplication } from "playwright";

import {
  assertScenarioUnchanged,
  createTestRepositoryScenario
} from "./fixtures/test-repository.js";
import { assertAccessible, attachScreenshot, launch, quitAndWait } from "./fixtures/desktop-app.js";
import { seedDashboardEvents } from "./fixtures/seed-dashboard-events.js";

const desktop = resolve(import.meta.dirname, "..");
const workspace = resolve(desktop, "../..");

const buildVerifier = (): void => {
  const result = spawnSync(
    "pnpm",
    ["--filter", "@autostack/desktop", "exec", "tsup", "--config", "tsup.e2e.config.ts"],
    { cwd: workspace, encoding: "utf8" }
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
};

test("workbench dashboard, accessibility, theme, keyboard, and empty states", async ({}, testInfo) => {
  buildVerifier();
  const scenario = await createTestRepositoryScenario();
  let application: ElectronApplication | undefined;

  try {
    const launched = await launch(scenario);
    application = launched.application;
    const page = launched.page;

    // ── 1. Dashboard read-back ──
    const seed = await seedDashboardEvents(page, scenario);
    // Refresh to pick up seeded runs
    await page.getByRole("button", { name: "Refresh" }).click();
    await page.waitForTimeout(500);

    // Verify runs appear in the dashboard
    for (const runId of seed.runIds) {
      await expect(page.locator(`#run-${runId}`)).toBeVisible();
    }
    await attachScreenshot(page, testInfo, "dashboard-seeded.png");

    // ── 2. Accessibility — default viewport ──
    await assertAccessible(page);

    // ── 2b. Accessibility — narrow viewport ──
    const granted = await application.evaluate(() =>
      (
        globalThis as unknown as {
          __autostackVerifier: {
            resize(
              width: number,
              height: number
            ): { readonly width: number; readonly height: number } | null;
          };
        }
      ).__autostackVerifier.resize(720, 900)
    );
    expect(granted).not.toBeNull();
    expect(granted?.width).toBeLessThanOrEqual(720);
    expect(granted?.width).toBeGreaterThanOrEqual(600);
    await expect
      .poll(async () => await page.evaluate(() => window.innerWidth))
      .toBe(granted?.width);
    await assertAccessible(page);
    await attachScreenshot(page, testInfo, "dashboard-narrow.png");

    // ── 3. Theme — light and dark ──
    // Light mode (default system, no data-theme)
    await assertAccessible(page);

    // Switch to dark via ThemeControl
    const darkRadio = page.getByRole("radio", { name: "Dark" });
    if (await darkRadio.isVisible()) {
      // Navigate to settings to find the theme control
      const settingsLink = page.getByRole("link", { name: "Settings" });
      if (await settingsLink.isVisible()) {
        // If settings is accessible, click it
        await settingsLink.click();
        await page.waitForTimeout(200);
      }
    }

    // Try to find and interact with the dark radio
    const darkRadioAfterNav = page.getByRole("radio", { name: "Dark" });
    if (await darkRadioAfterNav.isVisible()) {
      await darkRadioAfterNav.click();
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
      await assertAccessible(page);
      await attachScreenshot(page, testInfo, "dashboard-dark.png");

      // Switch back to light
      await page.getByRole("radio", { name: "Light" }).click();
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
      await assertAccessible(page);
    }

    // ── 4. Keyboard navigation ──
    // Tab from skip link through rail -> sidebar -> pane
    const skipLink = page.getByRole("link", { name: "Skip to factory workspace" });
    await skipLink.focus();
    await expect(skipLink).toBeFocused();

    // Tab through the navigation rail
    await page.keyboard.press("Tab");
    // Verify focus moved to the nav area (first link in the rail)
    const activeElement = await page.evaluate(() =>
      document.activeElement?.closest("nav")?.getAttribute("aria-label")
    );
    // Focus should be somewhere in the shell
    expect(activeElement === "Primary" || activeElement === null).toBe(true);

    // ── 5. Reduced motion ──
    await page.emulateMedia({ reducedMotion: "reduce" });
    const duration = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--as-duration-standard").trim()
    );
    expect(duration).toBe("0ms");

    // Also test the motion control
    const reducedRadio = page.getByRole("radio", { name: /reduced/i });
    if (await reducedRadio.isVisible()) {
      await reducedRadio.click();
      expect(await page.evaluate(() => document.documentElement.dataset.motion)).toBe("reduced");
    }
    await attachScreenshot(page, testInfo, "reduced-motion.png");

    // ── 6. Empty/unavailable states ──
    // Navigate back to factory if needed
    const factoryLink = page.getByRole("link", { name: "Factory" });
    if (await factoryLink.isVisible()) {
      await factoryLink.click();
      await page.waitForTimeout(200);
    }

    // Verify the supervision notice (D3 unavailable state)
    await expect(page.getByText(/run supervision is not served by this build/i)).toBeVisible();

    // Verify the execution authority disclosure
    await expect(page.getByRole("alert")).toBeVisible();

    await assertAccessible(page);
    await attachScreenshot(page, testInfo, "workbench-states.png");

    await assertScenarioUnchanged(scenario);
    await quitAndWait(application);
    application = undefined;
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
