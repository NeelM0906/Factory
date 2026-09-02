// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import axe from "axe-core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider, type ThemeStorage } from "@autostack/ui";

import { App } from "../src/app.js";
import type { AutoStackApiClient } from "../src/api-client.js";

const health = {
  service: "autostack-control-plane" as const,
  version: "0.1.0",
  status: "ok" as const,
  storage: { status: "ok" as const, journalMode: "wal" as const, schemaVersion: 1 },
  executor: { status: "idle" as const }
};

const makeClient = (): AutoStackApiClient => ({
  health: vi.fn(async () => health),
  listRuns: vi.fn(async () => ({ items: [] })),
  listRunEvents: vi.fn(async (_runId, afterGlobalSequence = 0) => ({
    events: [],
    nextSequence: afterGlobalSequence
  })),
  createRun: vi.fn(),
  listApprovals: vi.fn(),
  decideApproval: vi.fn(),
  steerRun: vi.fn(),
  cancelRun: vi.fn(),
  answerClarification: vi.fn()
});

const makeStorage = (): ThemeStorage => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    }
  };
};

const expectNoViolations = async (container: HTMLElement): Promise<void> => {
  const results = await axe.run(container, { resultTypes: ["violations"] });
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-motion");
});

describe("Web accessibility gate", () => {
  it.each(["light", "dark"] as const)(
    "has no accessibility violations in the %s theme",
    async (theme) => {
      document.documentElement.dataset.theme = theme;
      const { container } = render(
        <ThemeProvider storage={makeStorage()}>
          <App client={makeClient()} />
        </ThemeProvider>
      );
      await screen.findByRole("heading", { name: "AutoStack Factory" });
      await expectNoViolations(container);
    }
  );

  it("has no accessibility violations in the factory dashboard", async () => {
    const { container } = render(
      <ThemeProvider storage={makeStorage()}>
        <App client={makeClient()} />
      </ThemeProvider>
    );
    await screen.findByRole("heading", { name: "AutoStack Factory" });
    await expectNoViolations(container);
  });

  it("has no accessibility violations when the connection panel is shown", async () => {
    const { container } = render(
      <ThemeProvider storage={makeStorage()}>
        <App />
      </ThemeProvider>
    );
    await screen.findByRole("heading", { name: "Connect this AutoStack session" });
    await expectNoViolations(container);
  });

  it("has no accessibility violations in the error state", async () => {
    const badClient: AutoStackApiClient = {
      health: vi.fn(async () => {
        throw new Error("unreachable");
      }),
      listRuns: vi.fn(async () => {
        throw new Error("unreachable");
      }),
      listRunEvents: vi.fn(async () => {
        throw new Error("unreachable");
      }),
      createRun: vi.fn(),
      listApprovals: vi.fn(),
      decideApproval: vi.fn(),
      steerRun: vi.fn(),
      cancelRun: vi.fn(),
      answerClarification: vi.fn()
    };
    const { container } = render(
      <ThemeProvider storage={makeStorage()}>
        <App client={badClient} />
      </ThemeProvider>
    );
    await vi.waitFor(() => {
      expect(screen.getByRole("alert")).toBeVisible();
    });
    await expectNoViolations(container);
  });

  it("reflects the theme preference on the document root element", () => {
    const storage = makeStorage();
    render(
      <ThemeProvider storage={storage}>
        <App client={makeClient()} />
      </ThemeProvider>
    );

    // ThemeProvider with "system" default: no data-theme attribute
    expect(document.documentElement.dataset.theme).toBeUndefined();

    // Simulate switching to dark via the ThemeProvider's own effect
    // by rendering with a pre-seeded storage
    cleanup();
    const darkStorage = makeStorage();
    darkStorage.setItem("autostack.theme", "dark");
    render(
      <ThemeProvider storage={darkStorage}>
        <App client={makeClient()} />
      </ThemeProvider>
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
