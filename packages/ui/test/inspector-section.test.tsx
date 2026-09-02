// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { InspectorSection, type InspectorRow } from "../src/inspector-section.js";

afterEach(cleanup);

describe("InspectorSection — structure", () => {
  it("renders a labelled section wrapping a definition list", () => {
    const rows: readonly InspectorRow[] = [
      { term: "Harness", value: "claude-code" },
      { term: "Route", value: "sonnet-5" }
    ];
    render(<InspectorSection title="Harness" rows={rows} />);

    const section = screen.getByRole("region", { name: "Harness" });
    expect(section.tagName).toBe("SECTION");
    expect(section.querySelector("dl")).not.toBeNull();

    expect(within(section).getByText("Harness", { selector: "dt" })).toBeVisible();
    expect(within(section).getByText("claude-code", { selector: "dd" })).toBeVisible();
    expect(within(section).getByText("Route", { selector: "dt" })).toBeVisible();
    expect(within(section).getByText("sonnet-5", { selector: "dd" })).toBeVisible();
  });

  it("renders one dt/dd pair per row, in order", () => {
    const rows: readonly InspectorRow[] = [
      { term: "Environment", value: "production" },
      { term: "Policy", value: "restricted" },
      { term: "Provenance", value: "signed" }
    ];
    render(<InspectorSection title="Details" rows={rows} />);

    const section = screen.getByRole("region", { name: "Details" });
    const terms = section.querySelectorAll("dt");
    const values = section.querySelectorAll("dd");
    expect(terms).toHaveLength(3);
    expect(values).toHaveLength(3);
    expect(Array.from(terms).map((node) => node.textContent)).toEqual([
      "Environment",
      "Policy",
      "Provenance"
    ]);
  });
});

describe("InspectorSection — absent value (guard)", () => {
  it('renders "Not recorded" for an absent value', () => {
    const rows: readonly InspectorRow[] = [{ term: "Usage" }];
    render(<InspectorSection title="Usage" rows={rows} />);

    const section = screen.getByRole("region", { name: "Usage" });
    expect(within(section).getByText("Not recorded", { selector: "dd" })).toBeVisible();
  });

  it("renders a real numeric 0 as literal 0, never as Not recorded or an empty string", () => {
    const rows: readonly InspectorRow[] = [{ term: "Retries", value: 0 }];
    render(<InspectorSection title="Usage" rows={rows} />);

    const section = screen.getByRole("region", { name: "Usage" });
    const dd = within(section).getByText("Retries", { selector: "dt" }).nextElementSibling;
    expect(dd).not.toBeNull();
    expect(dd?.textContent).toBe("0");
    expect(dd?.textContent).not.toBe("");
    expect(dd?.textContent).not.toBe("Not recorded");
  });

  it("renders an empty string value as the literal empty string, distinct from absent", () => {
    // exercises the branch: "" is a *present* value (falsy but not undefined),
    // so it must not be coerced into "Not recorded".
    const rows: readonly InspectorRow[] = [{ term: "Label", value: "" }];
    render(<InspectorSection title="Usage" rows={rows} />);

    const section = screen.getByRole("region", { name: "Usage" });
    const dd = within(section).getByText("Label", { selector: "dt" }).nextElementSibling;
    expect(dd).not.toBeNull();
    expect(dd?.textContent).toBe("");
  });

  it("mixes absent and present values correctly in the same list", () => {
    const rows: readonly InspectorRow[] = [
      { term: "Input tokens", value: 1200 },
      { term: "Output tokens" },
      { term: "Cost (USD)", value: 0 }
    ];
    render(<InspectorSection title="Usage" rows={rows} />);

    const section = screen.getByRole("region", { name: "Usage" });
    const values = Array.from(section.querySelectorAll("dd")).map((node) => node.textContent);
    expect(values).toEqual(["1200", "Not recorded", "0"]);
  });
});
