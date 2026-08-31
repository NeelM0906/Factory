// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createId, type PlanDocument } from "@autostack/contracts";

import { PlanPane } from "../src/panes/plan-pane.js";

afterEach(cleanup);

const uuid = (counter: number): string => {
  const hex = counter.toString(16).padStart(30, "0");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(12, 15)}`,
    `8${hex.slice(15, 18)}`,
    hex.slice(18, 30)
  ].join("-");
};

const workspaceId = createId("workspace", uuid(1));
const workItemId = createId("workItem", uuid(2));
const runId = createId("run", uuid(3));
const credentialRefA = createId("credentialRef", uuid(4));
const credentialRefB = createId("credentialRef", uuid(5));

const OCCURRED_AT = "2026-08-20T12:00:00.000Z";

function buildPlan(overrides: Partial<PlanDocument> = {}): PlanDocument {
  return {
    schemaVersion: 1,
    workspaceId,
    workItemId,
    runId,
    planDigest: "a".repeat(64),
    summary: "Implement the widget exporter.",
    acceptanceCriteria: ["Export succeeds for CSV.", "Export succeeds for JSON."],
    affectedAreas: ["packages/client-app"],
    risks: [{ severity: "high", summary: "May regress the legacy exporter." }],
    verificationCommands: [
      { executable: "pnpm", args: ["test"], usesShell: false, required: true }
    ],
    requiredPermissions: [{ kind: "filesystem_write", detail: "Writes export files to disk." }],
    requiredCredentialRefIds: [credentialRefA, credentialRefB],
    producedAt: OCCURRED_AT,
    ...overrides
  };
}

describe("PlanPane", () => {
  it("renders summary, ordered acceptance criteria, affected areas, risks, verification commands, required permissions, and credential ref IDs", () => {
    render(<PlanPane plan={buildPlan()} />);

    expect(screen.getByText("Implement the widget exporter.")).toBeInTheDocument();

    const criteriaList = screen.getByRole("region", { name: "Acceptance criteria" });
    const criteriaItems = within(criteriaList).getAllByRole("listitem");
    expect(criteriaItems.map((item) => item.textContent)).toEqual([
      "Export succeeds for CSV.",
      "Export succeeds for JSON."
    ]);

    expect(screen.getByText("packages/client-app")).toBeInTheDocument();
    expect(screen.getByText("high: May regress the legacy exporter.")).toBeInTheDocument();
    expect(screen.getByText("pnpm test")).toBeInTheDocument();
    expect(screen.getByText("filesystem_write: Writes export files to disk.")).toBeInTheDocument();
    expect(screen.getByText(credentialRefA)).toBeInTheDocument();
    expect(screen.getByText(credentialRefB)).toBeInTheDocument();
  });

  it("renders a visible, labelled shell marker when a command uses a shell", () => {
    render(
      <PlanPane
        plan={buildPlan({
          verificationCommands: [
            { executable: "sh", args: ["-c", "pnpm test"], usesShell: true, required: true }
          ]
        })}
      />
    );

    expect(screen.getByText("Runs via shell")).toBeInTheDocument();
    // Companion branch: the required marker renders when `required: true`.
    expect(screen.getByText(/\(required\)/)).toBeInTheDocument();
  });

  it("renders no shell marker and no required marker when the command uses neither", () => {
    render(
      <PlanPane
        plan={buildPlan({
          verificationCommands: [
            { executable: "pnpm", args: ["test"], usesShell: false, required: false }
          ]
        })}
      />
    );

    expect(screen.queryByText("Runs via shell")).not.toBeInTheDocument();
    // An optional command must not claim to be required — the marker is conditional, not constant.
    expect(screen.queryByText(/\(required\)/)).not.toBeInTheDocument();
  });

  it("renders a named absent state when there is no plan yet", () => {
    render(<PlanPane plan={undefined} />);

    expect(screen.getByText(/no plan recorded/i)).toBeInTheDocument();
  });
});
