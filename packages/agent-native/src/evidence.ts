import { admitTriageReport, digestTriageReport, type TriageReport } from "@autostack/contracts";

/**
 * Evidence wrappers for the native station roles: THIN delegations to the digest and admission
 * helpers in `@autostack/contracts` (station-evidence). This module deliberately defines NO
 * canonicalization of its own — the contracts helpers are the single canonical authority, so a
 * digest computed through here can never drift from one computed anywhere else in the system.
 *
 * T9/T10 add the plan and review wrappers beside these when those roles leave the placeholder
 * digest domain.
 */

/** Digests a triage report under the contracts' canonical form — `producedBy` INCLUDED (0.12). */
export const digestTriageEvidence = (report: TriageReport): Promise<string> =>
  digestTriageReport(report);

/**
 * Admits a triage report against the digest it was recorded under — the TWO-argument
 * digest-compare form, since triage is the first station and has no upstream document to bind to.
 */
export const admitTriageEvidence = (
  report: unknown,
  expectedDigest: string
): Promise<TriageReport> => admitTriageReport(report, expectedDigest);
