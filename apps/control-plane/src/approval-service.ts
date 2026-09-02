/**
 * Approval inbox service — lists approvals and decides them. The list reads all workspace events
 * and projects them into summaries; the decision route finds the approval in the run stream,
 * applies the decision, and commits the result.
 *
 * The decision route does NOT require an Idempotency-Key header (D9). The approval id itself
 * is the durable idempotency boundary: replaying the same decision against a decided approval
 * returns the original `decidedAt` with `replayed: true`; posting the opposite decision is a
 * 409 conflict.
 */

import {
  ApprovalIdSchema,
  ApprovalSchema,
  ListApprovalsResponseSchema,
  PendingDomainEventSchema,
  RunIdSchema,
  type Actor,
  type Approval,
  type ApprovalDecisionRequest,
  type ApprovalDecisionResponse,
  type ListApprovalsQuery,
  type ListApprovalsResponse,
  type WorkspaceId
} from "@autostack/contracts";
import {
  ApprovalDecisionConflictError,
  IneligibleApproverError,
  StaleApprovalEvidenceError,
  type CommitResult,
  type DurableStore,
  type StreamAppend
} from "@autostack/domain";

import { projectApprovals, toApprovalSummary } from "./approval-projection.js";

export class ApprovalNotFoundError extends Error {
  constructor(runId: string, approvalId: string) {
    super(`Approval ${approvalId} was not found on run ${runId}.`);
    this.name = "ApprovalNotFoundError";
  }
}

export class CrossRunApprovalError extends Error {
  constructor(runId: string, approvalId: string) {
    super(`Approval ${approvalId} does not belong to run ${runId}.`);
    this.name = "CrossRunApprovalError";
  }
}

export interface ApprovalServiceDependencies {
  readonly store: DurableStore;
  readonly workspaceId: WorkspaceId;
  readonly now: () => string;
}

const LOCAL_ACTOR: Actor = { kind: "user", id: "local-user", displayName: "Local User" };

export class ApprovalService {
  readonly #dependencies: ApprovalServiceDependencies;

  constructor(dependencies: ApprovalServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async list(query: ListApprovalsQuery): Promise<ListApprovalsResponse> {
    const events = await this.#dependencies.store.readAll({
      workspaceId: this.#dependencies.workspaceId,
      limit: 10_000
    });
    const projected = projectApprovals(events);
    const filtered = projected.filter((entry) => entry.approval.status === query.status);

    // Paginate: items after the cursor, limited to the requested page size.
    const actualStart =
      query.cursor === undefined
        ? 0
        : (() => {
            const index = filtered.findIndex((entry) => entry.globalSequence < query.cursor!);
            return index === -1 ? filtered.length : index;
          })();
    const page = filtered.slice(actualStart, actualStart + query.limit);
    const nextEntry = filtered[actualStart + query.limit];

    return ListApprovalsResponseSchema.parse({
      items: page.map(toApprovalSummary),
      ...(nextEntry === undefined ? {} : { nextCursor: nextEntry.globalSequence })
    });
  }

  async decide(
    runIdInput: string,
    approvalIdInput: string,
    request: ApprovalDecisionRequest
  ): Promise<ApprovalDecisionResponse> {
    const runId = RunIdSchema.parse(runIdInput);
    const approvalId = ApprovalIdSchema.parse(approvalIdInput);

    // Verify the run exists.
    if (
      !(await this.#dependencies.store.runExists({
        workspaceId: this.#dependencies.workspaceId,
        runId
      }))
    ) {
      throw new (await import("./run-service.js")).RunNotFoundError(runId);
    }

    // Read the run's events to find the approval.
    const events = await this.#dependencies.store.readRunEvents({
      workspaceId: this.#dependencies.workspaceId,
      runId
    });

    let approval: Approval | undefined;
    let streamVersion = 0;
    for (const event of events) {
      streamVersion = Math.max(streamVersion, event.streamVersion);
      if (event.type === "approval.requested") {
        const candidate = ApprovalSchema.parse(event.payload.approval);
        if (candidate.id === approvalId) {
          approval = candidate;
        }
      }
      if (event.type === "approval.decided" && event.payload.approvalId === approvalId) {
        if (approval !== undefined) {
          approval = ApprovalSchema.parse({
            ...approval,
            status: event.payload.decision,
            decision: {
              decision: event.payload.decision,
              actor: event.actor,
              origin: event.payload.origin,
              decidedAt: event.payload.decidedAt
            },
            updatedAt: event.payload.decidedAt
          });
        }
      }
    }

    if (approval === undefined) {
      throw new ApprovalNotFoundError(runId, approvalId);
    }
    if (approval.runId !== runId) {
      throw new CrossRunApprovalError(runId, approvalId);
    }

    // D9: The API route receives the evidenceDigest directly. Compare it against the approval's
    // stored digest rather than re-hashing through the domain function.
    if (request.evidenceDigest !== approval.evidenceDigest) {
      throw new StaleApprovalEvidenceError();
    }

    // Check approver eligibility.
    if (!approval.eligibleApproverIds.includes(LOCAL_ACTOR.id)) {
      throw new IneligibleApproverError(LOCAL_ACTOR.id);
    }

    // Handle idempotent replay: same decision is replayed, opposite is conflict.
    if (approval.status !== "pending") {
      if (approval.status === request.decision) {
        return {
          approvalId: approval.id,
          runId: approval.runId,
          status: approval.status,
          decidedAt: approval.decision!.decidedAt,
          replayed: true
        };
      }
      throw new ApprovalDecisionConflictError();
    }

    // Build the decision event.
    const occurredAt = this.#dependencies.now();
    const correlationId = runId.slice(runId.indexOf("_") + 1);
    const decidedApproval = ApprovalSchema.parse({
      ...approval,
      status: request.decision,
      decision: {
        decision: request.decision,
        actor: LOCAL_ACTOR,
        origin: request.origin,
        decidedAt: occurredAt
      },
      updatedAt: occurredAt
    });

    const event = PendingDomainEventSchema.parse({
      workspaceId: this.#dependencies.workspaceId,
      actor: LOCAL_ACTOR,
      correlationId,
      occurredAt,
      type: "approval.decided",
      payload: {
        approvalId: decidedApproval.id,
        runId: decidedApproval.runId,
        decision: request.decision,
        evidenceDigest: decidedApproval.evidenceDigest,
        origin: request.origin,
        decidedAt: occurredAt
      }
    });

    // Commit the decision.
    const idempotency = {
      scope: `api:approval-decision:${this.#dependencies.workspaceId}`,
      key: `${runId}:${approvalId}`
    };

    const append: StreamAppend = {
      stream: { kind: "run", id: runId },
      expectedVersion: streamVersion,
      events: [event]
    };

    let result: CommitResult;
    try {
      result = await this.#dependencies.store.commit({
        idempotency,
        appends: [append],
        jobs: []
      });
    } catch {
      // On OCC conflict, re-read to check if we replayed.
      const replay = await this.#dependencies.store.readCommitResult(idempotency);
      if (replay !== null) {
        const decidedEvent = replay.events.find((e) => e.type === "approval.decided");
        return {
          approvalId,
          runId,
          status: request.decision,
          decidedAt: (decidedEvent?.payload.decidedAt as string) ?? occurredAt,
          replayed: true
        };
      }
      throw new Error("The approval decision could not be committed.");
    }

    const decidedEvent = result.events.find((e) => e.type === "approval.decided");
    return {
      approvalId,
      runId,
      status: request.decision,
      decidedAt: (decidedEvent?.payload.decidedAt as string) ?? occurredAt,
      replayed: result.replayed
    };
  }
}
