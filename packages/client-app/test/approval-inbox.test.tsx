// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApprovalSchema,
  ApprovalSummarySchema,
  createId,
  type ApprovalSummary
} from "@autostack/contracts";

import { createApiClient, type AutoStackApiClient } from "../src/api-client.js";
import { ApiConflictError } from "../src/api-errors.js";
import { createMockApiServer, seedFactoryFixture } from "../src/testing/index.js";
import { ApprovalInbox, ApprovalRow } from "../src/approvals/approval-inbox.js";

afterEach(cleanup);

const TOKEN = "test-token";
const EMPTY_MESSAGE = "No approvals are pending.";

function buildApprovalSummary(overrides: Partial<ApprovalSummary> = {}): ApprovalSummary {
  return ApprovalSummarySchema.parse({
    approvalId: createId("approval"),
    runId: createId("run"),
    workItemId: createId("workItem"),
    title: "Plan approval for run",
    kind: "plan",
    status: "pending",
    evidenceDigest: "1".repeat(64),
    requestedAt: "2026-08-20T12:00:00.000Z",
    updatedAt: "2026-08-20T12:00:00.000Z",
    ...overrides
  });
}

function makeApprovalsClient(): AutoStackApiClient {
  return {
    health: vi.fn(),
    listRuns: vi.fn(),
    listRunEvents: vi.fn(),
    createRun: vi.fn(),
    listApprovals: vi.fn(),
    decideApproval: vi.fn(),
    steerRun: vi.fn(),
    cancelRun: vi.fn(),
    answerClarification: vi.fn()
  };
}

describe("ApprovalInbox: paging", () => {
  it("loads every pending approval past the first window", async () => {
    const server = createMockApiServer({ fixture: seedFactoryFixture({ approvalCount: 137 }) });
    render(
      <ApprovalInbox
        client={createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: server.fetch })}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: /load more approvals/i }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(137));
    expect(screen.queryByRole("button", { name: /load more approvals/i })).toBeNull();
  });
});

describe("ApprovalInbox: digest display", () => {
  it("displays the digest truncated, with the full value reachable by assistive technology", async () => {
    const digest = "ab".repeat(32);
    const approval = buildApprovalSummary({ evidenceDigest: digest });
    const client = makeApprovalsClient();
    vi.mocked(client.listApprovals).mockResolvedValueOnce({ items: [approval] });
    const { container } = render(<ApprovalInbox client={client} />);

    await screen.findByRole("listitem");

    expect(screen.getByText(`${digest.slice(0, 8)}…${digest.slice(-4)}`)).toBeInTheDocument();
    expect(screen.queryByText(digest)).not.toBeInTheDocument();
    expect(container.querySelector(`[aria-label="Evidence digest ${digest}"]`)).not.toBeNull();
  });
});

describe("ApprovalInbox: decisions bind to displayed evidence", () => {
  it(
    "sends the digest the row displayed when approving " +
      "(wrong impl: re-reading the current server digest instead of the displayed one)",
    async () => {
      const oldDigest = "1".repeat(64);
      const newDigest = "2".repeat(64);
      const approval = buildApprovalSummary({ evidenceDigest: oldDigest });
      const client = makeApprovalsClient();
      vi.mocked(client.listApprovals)
        .mockResolvedValueOnce({ items: [approval] })
        .mockResolvedValue({ items: [{ ...approval, evidenceDigest: newDigest }] });
      vi.mocked(client.decideApproval).mockResolvedValue({
        approvalId: approval.approvalId,
        runId: approval.runId,
        status: "approved",
        decidedAt: "2026-08-20T12:00:05.000Z",
        replayed: false
      });
      render(<ApprovalInbox client={client} />);

      fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

      await waitFor(() => expect(client.decideApproval).toHaveBeenCalledTimes(1));
      expect(client.decideApproval).toHaveBeenCalledWith(
        approval.runId,
        approval.approvalId,
        expect.objectContaining({ evidenceDigest: oldDigest })
      );
      // Proves no extra re-fetch happened before deciding — the digest came from the row's own
      // props, not from a fresh lookup.
      expect(client.listApprovals).toHaveBeenCalledTimes(1);
    }
  );
});

describe("ApprovalInbox: conflict handling", () => {
  it(
    "renders the conflict message, refreshes the row, and does not retry the decision " +
      "automatically (wrong impl: auto-retrying the decision on conflict)",
    async () => {
      const approval = buildApprovalSummary();
      const client = makeApprovalsClient();
      vi.mocked(client.listApprovals).mockResolvedValue({ items: [approval] });
      vi.mocked(client.decideApproval).mockRejectedValue(new ApiConflictError());
      render(<ApprovalInbox client={client} />);

      fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(new ApiConflictError().message);
      await waitFor(() => expect(client.listApprovals).toHaveBeenCalledTimes(2));
      expect(client.decideApproval).toHaveBeenCalledTimes(1);
    }
  );
});

describe("ApprovalInbox: replayed decisions", () => {
  it(
    "renders a replayed decision as already-decided, not as a new decision " +
      "(wrong impl: skip the status update when replayed)",
    async () => {
      const approval = buildApprovalSummary();
      const client = makeApprovalsClient();
      vi.mocked(client.listApprovals).mockResolvedValueOnce({ items: [approval] });
      vi.mocked(client.decideApproval).mockResolvedValue({
        approvalId: approval.approvalId,
        runId: approval.runId,
        status: "approved",
        decidedAt: "2026-08-20T12:00:05.000Z",
        replayed: true
      });
      render(<ApprovalInbox client={client} />);

      fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

      await waitFor(() =>
        expect(screen.getByRole("listitem").querySelector("[data-cue]")).toHaveAttribute(
          "data-cue",
          "approved"
        )
      );
      expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    }
  );
});

describe("ApprovalRow: status cues", () => {
  it.each(ApprovalSchema.shape.status.options)(
    "gives %s a non-color cue and a text label",
    (status) => {
      const approval = buildApprovalSummary({ status });
      render(<ApprovalRow approval={approval} />);
      const row = screen.getByRole("listitem");
      expect(within(row).getByText(new RegExp(status.replace("_", " "), "i"))).toBeInTheDocument();
      expect(row.querySelector("[data-cue]")?.textContent?.trim()).not.toBe("");
    }
  );
});

describe("ApprovalInbox: empty and error states", () => {
  it("shows a distinct empty state when there are no pending approvals", async () => {
    const client = makeApprovalsClient();
    vi.mocked(client.listApprovals).mockResolvedValueOnce({ items: [] });
    render(<ApprovalInbox client={client} />);

    expect(await screen.findByText(EMPTY_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a distinct error state when the initial load fails", async () => {
    const client = makeApprovalsClient();
    vi.mocked(client.listApprovals).mockRejectedValueOnce(new Error("offline"));
    render(<ApprovalInbox client={client} />);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_MESSAGE)).not.toBeInTheDocument();
  });

  it("retries the initial load when Retry is clicked", async () => {
    const approval = buildApprovalSummary();
    const client = makeApprovalsClient();
    vi.mocked(client.listApprovals)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ items: [approval] });
    render(<ApprovalInbox client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    await screen.findByRole("listitem");
    expect(client.listApprovals).toHaveBeenCalledTimes(2);
  });
});

describe("ApprovalInbox: rejecting and non-conflict failures", () => {
  it("sends a rejected decision when Reject is clicked", async () => {
    const approval = buildApprovalSummary();
    const client = makeApprovalsClient();
    vi.mocked(client.listApprovals).mockResolvedValueOnce({ items: [approval] });
    vi.mocked(client.decideApproval).mockResolvedValue({
      approvalId: approval.approvalId,
      runId: approval.runId,
      status: "rejected",
      decidedAt: "2026-08-20T12:00:05.000Z",
      replayed: false
    });
    render(<ApprovalInbox client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));

    await waitFor(() =>
      expect(screen.getByRole("listitem").querySelector("[data-cue]")).toHaveAttribute(
        "data-cue",
        "rejected"
      )
    );
    expect(client.decideApproval).toHaveBeenCalledWith(
      approval.runId,
      approval.approvalId,
      expect.objectContaining({ decision: "rejected" })
    );
  });

  it("shows a generic message when a decision fails for a reason other than a conflict", async () => {
    const approval = buildApprovalSummary();
    const client = makeApprovalsClient();
    vi.mocked(client.listApprovals).mockResolvedValueOnce({ items: [approval] });
    vi.mocked(client.decideApproval).mockRejectedValue(new Error("network down"));
    render(<ApprovalInbox client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The decision could not be sent. Try again."
    );
  });
});

describe("ApprovalInbox: status filter", () => {
  it(
    "offers every schema status plus All, sourced from the schema rather than a hand-written list " +
      "(wrong impl: a hand-written options list)",
    async () => {
      const client = makeApprovalsClient();
      vi.mocked(client.listApprovals).mockResolvedValueOnce({ items: [buildApprovalSummary()] });
      render(<ApprovalInbox client={client} />);

      await screen.findByRole("listitem");

      const select = screen.getByRole("combobox", { name: /status/i });
      const optionValues = within(select)
        .getAllByRole("option")
        .map((option) => option.getAttribute("value"));

      expect(optionValues).toEqual(["all", ...ApprovalSchema.shape.status.options]);
    }
  );

  it("sends the selected status as the query's status filter", async () => {
    const client = makeApprovalsClient();
    vi.mocked(client.listApprovals).mockResolvedValue({ items: [] });
    render(<ApprovalInbox client={client} />);
    await waitFor(() => expect(client.listApprovals).toHaveBeenCalledTimes(1));

    const select = screen.getByRole("combobox", { name: /status/i });
    fireEvent.change(select, { target: { value: "approved" } });

    await waitFor(() => expect(client.listApprovals).toHaveBeenCalledTimes(2));
    expect(client.listApprovals).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "approved" }),
      expect.anything()
    );
  });

  it('sends the explicit "all" wildcard when "All" is selected (db926c3: the route treats it as unfiltered)', async () => {
    const client = makeApprovalsClient();
    vi.mocked(client.listApprovals).mockResolvedValue({ items: [] });
    render(<ApprovalInbox client={client} />);
    await waitFor(() => expect(client.listApprovals).toHaveBeenCalledTimes(1));

    const select = screen.getByRole("combobox", { name: /status/i });
    fireEvent.change(select, { target: { value: "approved" } });
    await waitFor(() => expect(client.listApprovals).toHaveBeenCalledTimes(2));

    fireEvent.change(select, { target: { value: "all" } });
    await waitFor(() => expect(client.listApprovals).toHaveBeenCalledTimes(3));

    const lastCall = vi.mocked(client.listApprovals).mock.calls.at(-1);
    // Positive assertion: "All" SENDS status "all" — omitting the field would silently degrade to
    // the server's "pending" default (the filter-UI-that-lies defect db926c3 names).
    expect(lastCall?.[0]).toEqual({ status: "all" });
  });
});

describe("ApprovalInbox: busy row", () => {
  it(
    "disables a row's controls while its decision is in flight, without unmounting the row " +
      "(wrong impl: unmounting the row while busy instead of disabling it)",
    async () => {
      const approval = buildApprovalSummary();
      const client = makeApprovalsClient();
      vi.mocked(client.listApprovals).mockResolvedValueOnce({ items: [approval] });
      vi.mocked(client.decideApproval).mockReturnValue(new Promise(() => undefined));
      render(<ApprovalInbox client={client} />);

      const approveButton = await screen.findByRole("button", { name: "Approve" });
      const rowBefore = screen.getByRole("listitem");

      fireEvent.click(approveButton);

      await waitFor(() => expect(approveButton).toBeDisabled());
      expect(screen.getByRole("listitem")).toBe(rowBefore);
      expect(screen.getByText(approval.title)).toBeInTheDocument();
    }
  );
});
