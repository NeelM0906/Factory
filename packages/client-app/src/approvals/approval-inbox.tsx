import { useCallback, useState, type ChangeEvent, type ReactElement } from "react";

import {
  ApprovalSchema,
  type ApprovalDecisionResponse,
  type ApprovalSummary
} from "@autostack/contracts";

import type { AutoStackApiClient } from "../api-client.js";
import { ApiConflictError } from "../api-errors.js";
import { useApprovals } from "./use-approvals.js";

type Decision = "approved" | "rejected";
type DecidedStatus = ApprovalDecisionResponse["status"];

interface StatusPresentation {
  readonly label: string;
  readonly cue: string;
}

/**
 * One entry per `ApprovalSchema.shape.status` member. `Record<ApprovalSummary["status"], ...>` is
 * exhaustive at the type level: a status added to the contract without a matching entry here fails
 * `tsc`, and `it.each(ApprovalSchema.shape.status.options)` in `approval-inbox.test.tsx` fails it
 * at the DOM level too (required change 5 — non-color-only, schema-sourced).
 */
const STATUS_PRESENTATION: Record<ApprovalSummary["status"], StatusPresentation> = {
  pending: { label: "Pending", cue: "◐" },
  approved: { label: "Approved", cue: "✓" },
  rejected: { label: "Rejected", cue: "✕" },
  stale: { label: "Stale", cue: "!" }
};

const EMPTY_MESSAGE = "No approvals are pending.";
const GENERIC_DECISION_FAILURE_MESSAGE = "The decision could not be sent. Try again.";
const STATUS_FILTER_ID = "approval-status-filter";
/**
 * `ListApprovalsQuerySchema.status` has no wildcard member — it is one specific status, defaulting
 * server-side to `"pending"` when omitted (`packages/contracts/src/api.ts`). "All" is therefore a
 * UI-only sentinel meaning "send no `status` field"; at the server that is indistinguishable from
 * explicitly requesting `"pending"`, since that is what an omitted `status` resolves to. This is a
 * known limitation of the contract, not a bug in the filter — there is no query shape that asks
 * the server for every status in one call.
 */
const ALL_STATUS_VALUE = "all";

function truncateDigest(digest: string): string {
  return `${digest.slice(0, 8)}…${digest.slice(-4)}`;
}

export interface ApprovalRowProps {
  readonly approval: ApprovalSummary;
  readonly busy?: boolean;
  readonly errorMessage?: string;
  readonly onDecide?: (decision: Decision) => void;
}

/**
 * One approval. The status cue is a `[data-cue]` element carrying its own visible text (never
 * color alone), and the evidence digest is shown truncated with the full value reachable through
 * `aria-label` — the CSS truncation itself is a Task 15b/Playwright concern (jsdom is CSS-blind
 * here), so this only asserts the DOM content, not how it is styled.
 */
export function ApprovalRow({
  approval,
  busy = false,
  errorMessage,
  onDecide
}: ApprovalRowProps): ReactElement {
  const presentation = STATUS_PRESENTATION[approval.status];
  return (
    <li className="approval-row">
      <h3>{approval.title}</h3>
      <span
        className="approval-status"
        role="status"
        aria-label={`Approval status: ${presentation.label}`}
      >
        <span data-cue={approval.status} aria-hidden="true">
          {presentation.cue}
        </span>
        <span>{presentation.label}</span>
      </span>
      <span aria-label={`Evidence digest ${approval.evidenceDigest}`}>
        {truncateDigest(approval.evidenceDigest)}
      </span>
      {approval.status === "pending" && (
        <div className="approval-actions">
          <button type="button" disabled={busy} onClick={() => onDecide?.("approved")}>
            {busy ? "Deciding…" : "Approve"}
          </button>
          <button type="button" disabled={busy} onClick={() => onDecide?.("rejected")}>
            {busy ? "Deciding…" : "Reject"}
          </button>
        </div>
      )}
      {errorMessage === undefined ? null : (
        <p className="approval-row-error" role="alert">
          {errorMessage}
        </p>
      )}
    </li>
  );
}

export interface ApprovalInboxProps {
  readonly client: AutoStackApiClient | null;
}

/**
 * The approval inbox: `useApprovals` for the paged list, plus decision handling bound to each
 * row's own displayed data. A decision always sends the `evidenceDigest` the row is currently
 * rendering (never a value re-read from the server at decide-time), which is what makes a stale
 * decision detectable server-side at all (D2).
 */
export function ApprovalInbox({ client }: ApprovalInboxProps): ReactElement {
  // Starts on "pending" (not the "All" sentinel) so the select's displayed value always matches
  // what is actually shown — defaulting it to "All" while the inbox in fact shows only pending
  // approvals (the server's own default) would be misleading.
  const [selectedStatus, setSelectedStatus] = useState<ApprovalSummary["status"] | undefined>(
    "pending"
  );
  const { state, loadMore, refresh } = useApprovals(client, selectedStatus);
  const [pendingDecisions, setPendingDecisions] = useState<ReadonlySet<string>>(new Set());
  const [decisionErrors, setDecisionErrors] = useState<Readonly<Record<string, string>>>({});
  const [decidedOverrides, setDecidedOverrides] = useState<Readonly<Record<string, DecidedStatus>>>(
    {}
  );

  const handleStatusFilterChange = useCallback((event: ChangeEvent<HTMLSelectElement>): void => {
    const raw = event.target.value;
    if (raw === ALL_STATUS_VALUE) {
      setSelectedStatus(undefined);
      return;
    }
    // Schema-validated rather than cast: `raw` only ever equals a value this same <select>
    // rendered as one of its own <option>s, but that guarantee lives in the render code, not the
    // type system — re-checking it against the contract avoids asserting it away with `as`.
    const parsedStatus = ApprovalSchema.shape.status.safeParse(raw);
    if (parsedStatus.success) setSelectedStatus(parsedStatus.data);
  }, []);

  const decide = useCallback(
    async (approval: ApprovalSummary, decision: Decision): Promise<void> => {
      if (client === null) return;
      setPendingDecisions((current) => new Set(current).add(approval.approvalId));
      setDecisionErrors((current) => {
        const { [approval.approvalId]: ignoredError, ...rest } = current;
        void ignoredError;
        return rest;
      });
      try {
        // D2 / the displayed-evidence guard: `approval` here is exactly the object this row was
        // rendered with — never re-read from the server at decide-time. A decision built from a
        // freshly re-fetched digest would never conflict, which defeats the point of the check.
        const response = await client.decideApproval(approval.runId, approval.approvalId, {
          decision,
          evidenceDigest: approval.evidenceDigest,
          origin: "web"
        });
        // A `replayed: true` response still means the approval IS decided — it renders as
        // already-decided, never as a no-op that leaves the row showing "pending".
        setDecidedOverrides((current) => ({ ...current, [approval.approvalId]: response.status }));
      } catch (error) {
        if (error instanceof ApiConflictError) {
          // D2: no branch on conflict cause (the error carries none — structural) and no automatic
          // retry. The row is refreshed with the server's current data; the user must act again.
          setDecisionErrors((current) => ({ ...current, [approval.approvalId]: error.message }));
          await refresh();
          return;
        }
        setDecisionErrors((current) => ({
          ...current,
          [approval.approvalId]: GENERIC_DECISION_FAILURE_MESSAGE
        }));
      } finally {
        setPendingDecisions((current) => {
          const next = new Set(current);
          next.delete(approval.approvalId);
          return next;
        });
      }
    },
    [client, refresh]
  );

  // The filter is always visible, independent of `state.status` — a user viewing an empty or
  // failed status filter must still be able to switch back to one that has data.
  const statusFilter = (
    <div className="approval-filter">
      <label htmlFor={STATUS_FILTER_ID}>Status</label>
      <select
        id={STATUS_FILTER_ID}
        value={selectedStatus ?? ALL_STATUS_VALUE}
        onChange={handleStatusFilterChange}
      >
        <option value={ALL_STATUS_VALUE}>All</option>
        {ApprovalSchema.shape.status.options.map((status) => (
          <option key={status} value={status}>
            {STATUS_PRESENTATION[status].label}
          </option>
        ))}
      </select>
    </div>
  );

  const body: ReactElement =
    state.status === "loading" || state.status === "disconnected" ? (
      <p role="status" aria-label="Loading approvals">
        Loading approvals…
      </p>
    ) : state.status === "error" ? (
      <div className="error-state" role="alert">
        <p>{state.message}</p>
        <button type="button" onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    ) : state.approvals.length === 0 ? (
      <div className="empty-state">
        <strong>No approvals</strong>
        <p>{EMPTY_MESSAGE}</p>
      </div>
    ) : (
      <>
        <ul className="approval-list">
          {state.approvals.map((approval) => {
            const decidedStatus = decidedOverrides[approval.approvalId];
            const displayed: ApprovalSummary =
              decidedStatus === undefined ? approval : { ...approval, status: decidedStatus };
            const rowErrorMessage = decisionErrors[approval.approvalId];
            return (
              <ApprovalRow
                key={approval.approvalId}
                approval={displayed}
                busy={pendingDecisions.has(approval.approvalId)}
                {...(rowErrorMessage === undefined ? {} : { errorMessage: rowErrorMessage })}
                onDecide={(decision) => void decide(displayed, decision)}
              />
            );
          })}
        </ul>
        {state.paginationMessage === undefined ? null : (
          <p className="error-state" role="alert">
            {state.paginationMessage}
          </p>
        )}
        {state.nextCursor === undefined ? null : (
          <button type="button" disabled={state.loadingMore} onClick={() => void loadMore()}>
            {state.loadingMore ? "Loading more approvals…" : "Load more approvals"}
          </button>
        )}
      </>
    );

  return (
    <div className="approval-inbox">
      {statusFilter}
      {body}
    </div>
  );
}
