/**
 * Approval inbox projection — folds `approval.requested` and `approval.decided` events into
 * a list of approval summaries keyed by approval id, filterable by status. The projection
 * is derived from the full event stream, not stored separately — Milestone A does not
 * require a materialized view.
 */

import {
  ApprovalSchema,
  ApprovalSummarySchema,
  type Approval,
  type ApprovalSummary,
  type StoredDomainEvent
} from "@autostack/contracts";

export interface ApprovalProjectionEntry {
  readonly approval: Approval;
  readonly title: string;
  readonly workItemId: string;
  readonly globalSequence: number;
}

/**
 * Folds workspace events into approval summaries for the inbox. Work item titles are resolved
 * by scanning the event stream for `work_item.created` and `run.created` events.
 */
export const projectApprovals = (
  events: readonly StoredDomainEvent[]
): readonly ApprovalProjectionEntry[] => {
  // Map work item id to title.
  const workItemTitles = new Map<string, string>();
  // Map run id to work item id.
  const runToWorkItem = new Map<string, string>();
  const approvals = new Map<string, ApprovalProjectionEntry>();

  for (const event of events) {
    if (event.type === "work_item.created") {
      const wi = event.payload.workItem;
      workItemTitles.set(wi.id as string, wi.title as string);
      continue;
    }
    if (event.type === "run.created") {
      const run = event.payload.run;
      runToWorkItem.set(run.id as string, run.workItemId as string);
      continue;
    }
    if (event.type === "approval.requested") {
      const approval = ApprovalSchema.parse(event.payload.approval);
      const workItemId = runToWorkItem.get(approval.runId) ?? "";
      const title = workItemTitles.get(workItemId) ?? `Approval ${approval.id}`;
      approvals.set(approval.id, {
        approval,
        title,
        workItemId,
        globalSequence: event.globalSequence
      });
      continue;
    }
    if (event.type === "approval.decided") {
      const entry = approvals.get(event.payload.approvalId as string);
      if (entry === undefined) continue;
      const decided = ApprovalSchema.parse({
        ...entry.approval,
        status: event.payload.decision,
        decision: {
          decision: event.payload.decision,
          actor: event.actor,
          origin: event.payload.origin,
          decidedAt: event.payload.decidedAt
        },
        updatedAt: event.payload.decidedAt
      });
      approvals.set(decided.id, {
        ...entry,
        approval: decided,
        globalSequence: event.globalSequence
      });
    }
  }

  return [...approvals.values()].sort(
    (left, right) => right.globalSequence - left.globalSequence
  );
};

/**
 * Converts a projection entry to an `ApprovalSummary` for the API response.
 */
export const toApprovalSummary = (entry: ApprovalProjectionEntry): ApprovalSummary =>
  ApprovalSummarySchema.parse({
    approvalId: entry.approval.id,
    runId: entry.approval.runId,
    workItemId: entry.workItemId,
    title: entry.title,
    kind: entry.approval.kind,
    status: entry.approval.status,
    evidenceDigest: entry.approval.evidenceDigest,
    requestedAt: entry.approval.createdAt,
    updatedAt: entry.approval.updatedAt
  });
