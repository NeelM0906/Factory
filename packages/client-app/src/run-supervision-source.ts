import type {
  AgentSessionStreamEvent,
  PlanDocument,
  ReviewReport,
  RunId,
  VerificationReport
} from "@autostack/contracts";

/**
 * Port for the run-supervision payloads the conversation, plan, and terminal panes render
 * (Task 5a).
 *
 * D3 (superseded by the R0 rebase — see "D3 — SUPERSEDED by the rebase: the transport exists" in
 * the S6 plan): the transport now exists. Both the agent session stream and the station evidence
 * documents ride the existing `/v1/runs/:runId/events` stream, as `agent.session_event` and
 * `pipeline.evidence_recorded` members of `ListEventsResponseSchema`. The event-derived
 * implementation — reducing a page of `StoredDomainEvent[]` into these four shapes — is Task 10a's
 * `App` composition work. This task ships only the fixture implementation,
 * `createFixtureRunSupervisionSource` (`./testing/fixture-run-supervision-source.js`), which the
 * panes are unit-tested against. `App` takes a `RunSupervisionSource` as an optional prop and
 * renders a named "not served by this build" state when none is supplied — that absent-source
 * state belongs to Task 10a, not here.
 */
export interface RunSupervisionSource {
  sessionEvents(
    runId: RunId,
    afterSequence: number,
    signal?: AbortSignal
  ): Promise<readonly AgentSessionStreamEvent[]>;
  planDocument(runId: RunId, signal?: AbortSignal): Promise<PlanDocument | undefined>;
  verificationReport(runId: RunId, signal?: AbortSignal): Promise<VerificationReport | undefined>;
  reviewReport(runId: RunId, signal?: AbortSignal): Promise<ReviewReport | undefined>;
}
