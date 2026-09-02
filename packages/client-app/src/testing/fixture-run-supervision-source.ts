import {
  AgentSessionStreamEventSchema,
  PlanDocumentSchema,
  ReviewReportSchema,
  VerificationReportSchema,
  type AgentSessionStreamEvent,
  type PlanDocument,
  type ReviewReport,
  type VerificationReport
} from "@autostack/contracts";

import type { RunSupervisionSource } from "../run-supervision-source.js";

/**
 * Raw fixture input, keyed by run ID (as a plain string — `RunId` is a branded string, so a
 * literal object key satisfies it). Every candidate is `unknown`: it is contract-`parse`d at
 * construction, so a malformed fixture fails where it is written, not where a pane later reads it.
 */
export interface RunSupervisionFixtureData {
  readonly sessionEvents?: Readonly<Record<string, readonly unknown[]>>;
  readonly planDocuments?: Readonly<Record<string, unknown>>;
  readonly verificationReports?: Readonly<Record<string, unknown>>;
  readonly reviewReports?: Readonly<Record<string, unknown>>;
}

const assertNotAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw new DOMException("Aborted", "AbortError");
};

/**
 * Builds a `RunSupervisionSource` backed by an in-memory fixture rather than a transport (D3 — see
 * `../run-supervision-source.ts`). Every value the fixture holds is `parse`d through its contract
 * schema here, at construction, so the source can never serve data its schema would reject.
 */
export function createFixtureRunSupervisionSource(
  fixture: RunSupervisionFixtureData
): RunSupervisionSource {
  const sessionEventsByRun = new Map<string, readonly AgentSessionStreamEvent[]>();
  for (const [runId, candidates] of Object.entries(fixture.sessionEvents ?? {})) {
    sessionEventsByRun.set(
      runId,
      candidates.map((candidate) => AgentSessionStreamEventSchema.parse(candidate))
    );
  }

  const planDocumentsByRun = new Map<string, PlanDocument>();
  for (const [runId, candidate] of Object.entries(fixture.planDocuments ?? {})) {
    planDocumentsByRun.set(runId, PlanDocumentSchema.parse(candidate));
  }

  const verificationReportsByRun = new Map<string, VerificationReport>();
  for (const [runId, candidate] of Object.entries(fixture.verificationReports ?? {})) {
    verificationReportsByRun.set(runId, VerificationReportSchema.parse(candidate));
  }

  const reviewReportsByRun = new Map<string, ReviewReport>();
  for (const [runId, candidate] of Object.entries(fixture.reviewReports ?? {})) {
    reviewReportsByRun.set(runId, ReviewReportSchema.parse(candidate));
  }

  return {
    async sessionEvents(runId, afterSequence, signal) {
      assertNotAborted(signal);
      const events = sessionEventsByRun.get(runId) ?? [];
      return events.filter((event) => event.sequence > afterSequence);
    },
    async planDocument(runId, signal) {
      assertNotAborted(signal);
      return planDocumentsByRun.get(runId);
    },
    async verificationReport(runId, signal) {
      assertNotAborted(signal);
      return verificationReportsByRun.get(runId);
    },
    async reviewReport(runId, signal) {
      assertNotAborted(signal);
      return reviewReportsByRun.get(runId);
    }
  };
}
