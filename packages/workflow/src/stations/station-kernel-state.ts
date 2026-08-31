import {
  ApprovalSchema,
  type AgentSessionId,
  type Approval,
  type ClarificationRequest,
  type ClarificationResponse,
  type Origin,
  type PipelineEvidence,
  type PipelineStationDocument,
  type Run,
  type RunId,
  type StoredDomainEvent
} from "@autostack/contracts";
import { transitionRun } from "@autostack/domain";

/** A question the run asked, with the answer once one arrived. */
export interface PipelineClarificationState {
  readonly request: ClarificationRequest;
  readonly response?: ClarificationResponse;
}

/**
 * One agent permission round trip relayed onto the run stream. These are the in-session asks a
 * station must answer, which is why they are folded separately from `approvals`: an `Approval` is a
 * durable human decision on plan, publish, or command permission, while this is a prompt the
 * harness is currently blocked on.
 */
export interface PipelinePermissionState {
  readonly agentSessionId: AgentSessionId;
  readonly permissionRef: string;
  readonly summary: string;
  readonly evidenceDigest: string;
  readonly selectedOptionId?: string;
}

/** An accepted steering instruction, in the order the run accepted it. */
export interface PipelineSteerState {
  readonly instruction: string;
  readonly origin: Origin;
  readonly actorId: string;
  readonly acceptedAt: string;
}

export interface PipelineRunState {
  /** Undefined when the supplied events do not include this run's `run.created`. */
  readonly run: Run | undefined;
  /** The run stream version at lease head — what `appendFor` stamps as `expectedVersion`. */
  readonly streamVersion: number;
  readonly priorEvidence: readonly PipelineEvidence[];
  readonly documents: readonly PipelineStationDocument[];
  readonly approvals: readonly Approval[];
  readonly clarifications: readonly PipelineClarificationState[];
  readonly permissions: readonly PipelinePermissionState[];
  readonly steers: readonly PipelineSteerState[];
  readonly cancelRequested: boolean;
}

const decide = (approval: Approval, event: StoredDomainEvent): Approval => {
  if (event.type !== "approval.decided") return approval;
  return ApprovalSchema.parse({
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
};

/**
 * Folds one run's durable events into the state a station reads before it decides.
 *
 * The run is named by the caller rather than discovered in the data: a station knows which run it
 * leased, and reading identity out of an event body is the mistake plan D13 forbids. Events for any
 * other run are ignored rather than rejected, so a caller may pass a wider read.
 */
export const readPipelineState = (
  events: readonly StoredDomainEvent[],
  runId: RunId
): PipelineRunState => {
  let run: Run | undefined;
  let streamVersion = 0;
  let cancelRequested = false;
  const priorEvidence: PipelineEvidence[] = [];
  const documents: PipelineStationDocument[] = [];
  const approvals = new Map<string, Approval>();
  const clarifications = new Map<string, PipelineClarificationState>();
  const permissions = new Map<string, PipelinePermissionState>();
  const steers: PipelineSteerState[] = [];

  for (const event of events) {
    if (event.stream.kind !== "run" || event.stream.id !== runId) continue;
    streamVersion = Math.max(streamVersion, event.streamVersion);

    switch (event.type) {
      case "run.created":
        run = event.payload.run;
        break;
      case "run.transitioned": {
        if (event.payload.to === "cancelling") cancelRequested = true;
        if (run === undefined) break;
        run = transitionRun({
          run,
          to: event.payload.to,
          reason: event.payload.reason,
          ...(event.payload.resumeStatus === undefined
            ? {}
            : { resumeStatus: event.payload.resumeStatus }),
          actor: event.actor,
          correlationId: event.correlationId,
          occurredAt: event.occurredAt
        }).run;
        break;
      }
      case "pipeline.evidence_recorded":
        priorEvidence.push(event.payload.evidence);
        if (event.payload.document !== undefined) documents.push(event.payload.document);
        break;
      case "approval.requested":
        approvals.set(event.payload.approval.id, event.payload.approval);
        break;
      case "approval.decided": {
        const approval = approvals.get(event.payload.approvalId);
        if (approval !== undefined) approvals.set(approval.id, decide(approval, event));
        break;
      }
      case "clarification.requested":
        clarifications.set(event.payload.request.clarificationRef, {
          request: event.payload.request
        });
        break;
      case "clarification.answered": {
        const asked = clarifications.get(event.payload.response.clarificationRef);
        if (asked !== undefined) {
          clarifications.set(asked.request.clarificationRef, {
            request: asked.request,
            response: event.payload.response
          });
        }
        break;
      }
      case "run.steered":
        steers.push({
          instruction: event.payload.instruction,
          origin: event.payload.origin,
          actorId: event.payload.actorId,
          acceptedAt: event.payload.acceptedAt
        });
        break;
      case "agent.session_event": {
        const relayed = event.payload.event;
        if (relayed.type === "permission_requested") {
          permissions.set(relayed.permissionRef, {
            agentSessionId: event.payload.agentSessionId,
            permissionRef: relayed.permissionRef,
            summary: relayed.summary,
            evidenceDigest: relayed.evidenceDigest
          });
        }
        if (relayed.type === "permission_resolved") {
          const asked = permissions.get(relayed.permissionRef);
          if (asked !== undefined) {
            permissions.set(relayed.permissionRef, {
              ...asked,
              selectedOptionId: relayed.selectedOptionId
            });
          }
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    run,
    streamVersion,
    priorEvidence,
    documents,
    approvals: [...approvals.values()],
    clarifications: [...clarifications.values()],
    permissions: [...permissions.values()],
    steers,
    cancelRequested
  };
};
