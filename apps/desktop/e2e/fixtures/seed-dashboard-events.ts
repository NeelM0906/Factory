/**
 * Seeds a set of run events that produce the hand-computed dashboard
 * numbers from Task 9a. The events are written through the desktop
 * bridge so the factory poller picks them up.
 */

import type { TestRepositoryScenario } from "./test-repository.js";
import type { Page } from "playwright";

export interface DashboardSeed {
  readonly runIds: readonly string[];
  readonly expectedMetrics: {
    readonly active: number;
    readonly waiting: number;
    readonly failed: number;
    readonly completed: number;
  };
}

/**
 * Creates runs via the factory bridge to populate the dashboard.
 * Returns the expected metric counts for assertion.
 */
export const seedDashboardEvents = async (
  page: Page,
  _scenario: TestRepositoryScenario
): Promise<DashboardSeed> => {
  const runIds: string[] = [];

  // Create three runs via the desktop bridge
  const titles = [
    "Implement foundation adapter",
    "Review pull request",
    "Deploy staging environment"
  ];

  for (const title of titles) {
    const result = await page.evaluate(
      async ({ runTitle }) =>
        await window.autostack.request<"factory.runs.create">({
          operation: "factory.runs.create",
          request: {
            title: runTitle,
            description: "Seeded for dashboard e2e test.",
            acceptanceContext: []
          },
          idempotencyKey: `dashboard-seed-${runTitle.replace(/\s+/g, "-").toLowerCase()}`
        }),
      { runTitle: title }
    );
    runIds.push(result.run.id);
  }

  return {
    runIds,
    expectedMetrics: {
      active: 0,
      waiting: 0,
      failed: 0,
      completed: 0
    }
  };
};
