import { createHash } from "node:crypto";

import {
  ApprovalSchema,
  PendingDomainEventSchema,
  canonicalizeApprovalEvidence,
  type Actor,
  type Approval,
  type ApprovalId,
  type PendingDomainEvent,
  type RunId,
  type WorkspaceId
} from "@autostack/contracts";

import {
  ApprovalDecisionConflictError,
  IneligibleApproverError,
  StaleApprovalEvidenceError
} from "./errors.js";

export const digestApprovalEvidence = (
  evidence: unknown,
  kind: "plan" | "publish" | "permission" = "plan"
): string =>
  createHash("sha256").update(canonicalizeApprovalEvidence(kind, evidence), "utf8").digest("hex");

export interface RequestApprovalCommand {
  readonly workspaceId: WorkspaceId;
  readonly runId: RunId;
  readonly kind: "plan" | "publish" | "permission";
  readonly evidence: unknown;
  readonly eligibleApproverIds: readonly string[];
  readonly actor: Actor;
  readonly correlationId: string;
}

export function requestApproval(
  command: RequestApprovalCommand,
  dependencies: { readonly now: () => string; readonly approvalId: () => ApprovalId }
): { readonly approval: Approval; readonly events: readonly PendingDomainEvent[] } {
  const occurredAt = dependencies.now();
  const approval = ApprovalSchema.parse({
    schemaVersion: 1,
    id: dependencies.approvalId(),
    workspaceId: command.workspaceId,
    runId: command.runId,
    kind: command.kind,
    status: "pending",
    evidenceDigest: digestApprovalEvidence(command.evidence, command.kind),
    eligibleApproverIds: command.eligibleApproverIds,
    createdAt: occurredAt,
    updatedAt: occurredAt
  });
  const event = PendingDomainEventSchema.parse({
    workspaceId: command.workspaceId,
    actor: command.actor,
    correlationId: command.correlationId,
    occurredAt,
    type: "approval.requested",
    payload: { approval }
  });

  return { approval, events: [event] };
}

export interface DecideApprovalCommand {
  readonly approval: Approval;
  readonly decision: "approved" | "rejected";
  readonly evidence: unknown;
  readonly actor: Actor;
  readonly origin: "desktop" | "web" | "cli" | "slack" | "github" | "api";
  readonly occurredAt: string;
  readonly correlationId: string;
}

export function decideApproval(command: DecideApprovalCommand): {
  readonly approval: Approval;
  readonly events: readonly PendingDomainEvent[];
} {
  if (
    digestApprovalEvidence(command.evidence, command.approval.kind) !==
    command.approval.evidenceDigest
  ) {
    throw new StaleApprovalEvidenceError();
  }
  if (!command.approval.eligibleApproverIds.includes(command.actor.id)) {
    throw new IneligibleApproverError(command.actor.id);
  }
  if (command.approval.status !== "pending") {
    if (command.approval.status === command.decision) {
      return { approval: command.approval, events: [] };
    }
    throw new ApprovalDecisionConflictError();
  }

  const approval = ApprovalSchema.parse({
    ...command.approval,
    status: command.decision,
    decision: {
      decision: command.decision,
      actor: command.actor,
      origin: command.origin,
      decidedAt: command.occurredAt
    },
    updatedAt: command.occurredAt
  });
  const event = PendingDomainEventSchema.parse({
    workspaceId: approval.workspaceId,
    actor: command.actor,
    correlationId: command.correlationId,
    occurredAt: command.occurredAt,
    type: "approval.decided",
    payload: {
      approvalId: approval.id,
      runId: approval.runId,
      decision: command.decision,
      evidenceDigest: approval.evidenceDigest,
      origin: command.origin,
      decidedAt: command.occurredAt
    }
  });

  return { approval, events: [event] };
}

export { ApprovalDecisionConflictError, IneligibleApproverError, StaleApprovalEvidenceError };
