// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RUN_STATUSES, RunStatusBadge } from "../src/index.js";

afterEach(cleanup);

describe("RunStatusBadge", () => {
  it.each(RUN_STATUSES)("renders %s with text, a shape cue, and an accessible label", (status) => {
    const { container } = render(<RunStatusBadge status={status} />);
    const badge = screen.getByRole("status");

    expect(badge).toBeVisible();
    expect(badge).toHaveAccessibleName(/^Run status: /);
    expect(badge.textContent?.trim()).not.toBe("");
    expect(container.querySelector('[aria-hidden="true"]')).toBeVisible();
  });
});
