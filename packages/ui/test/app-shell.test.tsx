// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AppShell, LifecycleStrip, MetricCard } from "../src/index.js";

describe("AutoStack shell primitives", () => {
  it("provides complete navigation, current destination, and named landmarks", () => {
    render(
      <AppShell
        activeDestination="factory"
        sidebar={<p>Run queue</p>}
        inspector={<p>Run details</p>}
      >
        <h1>Factory control room</h1>
      </AppShell>
    );

    const navigation = screen.getByRole("navigation", { name: "Primary" });
    for (const label of [
      "Factory",
      "Projects",
      "Automations",
      "Approvals",
      "Integrations",
      "Settings"
    ]) {
      expect(within(navigation).getByRole("link", { name: label })).toBeVisible();
    }
    expect(within(navigation).getByRole("link", { name: "Factory" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByRole("link", { name: "Skip to factory workspace" })).toHaveAttribute(
      "href",
      "#autostack-main"
    );
    expect(screen.getByRole("main", { name: "Factory workspace" })).toBeVisible();
    expect(screen.getByRole("complementary", { name: "Project and run navigation" })).toBeVisible();
    expect(screen.getByRole("complementary", { name: "Run inspector" })).toBeVisible();
  });

  it("renders lifecycle stages as an ordered, labelled sequence", () => {
    render(
      <LifecycleStrip
        stages={[
          { id: "signal", label: "Signal", state: "complete" },
          { id: "triage", label: "Triage", state: "active", detail: "2 active" },
          { id: "plan", label: "Plan", state: "waiting" }
        ]}
      />
    );

    const list = screen.getByRole("list", { name: "Software delivery lifecycle" });
    expect(list.tagName).toBe("OL");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText("Signal")).toBeVisible();
    expect(within(items[1]!).getByText("Triage")).toBeVisible();
    expect(within(items[1]!).getByText("2 active")).toBeVisible();
    expect(within(items[2]!).getByText("Plan")).toBeVisible();
  });

  it("gives metric tone semantic text independent of color", () => {
    render(<MetricCard label="Validation" value="98%" detail="Pass rate" tone="good" />);

    expect(screen.getByRole("group", { name: "Validation: 98%, Pass rate" })).toHaveTextContent(
      "Healthy"
    );
  });
});
