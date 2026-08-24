import {
  DisposeEnvironmentRequestSchema,
  TerminalRunEvidenceSchema,
  type DisposeEnvironmentRequest
} from "@autostack/contracts";
import type { TerminalEvidenceVerification } from "@autostack/runner-local";

interface AuthorizedEvidence {
  readonly request: DisposeEnvironmentRequest;
  readonly expiresAt: number;
}

const sameEvidence = (
  request: DisposeEnvironmentRequest,
  verification: TerminalEvidenceVerification
): boolean => {
  const evidence = TerminalRunEvidenceSchema.safeParse(verification.terminalRunEvidence);
  return (
    evidence.success &&
    verification.workspaceId === request.workspaceId &&
    verification.runId === request.runId &&
    verification.environmentId === request.environmentId &&
    verification.environmentAuthorizationId === request.environmentAuthorizationId &&
    verification.environmentAuthorizationDigest === request.environmentAuthorizationDigest &&
    evidence.data.status === request.terminalRunEvidence.status &&
    evidence.data.terminalEventSequence === request.terminalRunEvidence.terminalEventSequence &&
    evidence.data.terminalEventDigest === request.terminalRunEvidence.terminalEventDigest
  );
};

/**
 * One-shot evidence ledger populated only by the privileged control-plane utility channel.
 * The HTTP disposal body cannot populate this authority.
 */
export class DurableTerminalEvidenceAuthority {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #authorized = new Map<string, AuthorizedEvidence>();

  constructor(options: { readonly now?: () => number; readonly ttlMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 30_000;
  }

  authorize(candidate: unknown): void {
    const request = DisposeEnvironmentRequestSchema.parse(candidate);
    if (this.#authorized.size >= 1_024 && !this.#authorized.has(request.environmentId)) {
      throw new TypeError("terminal evidence authority is saturated");
    }
    this.#authorized.set(request.environmentId, {
      request: structuredClone(request),
      expiresAt: this.#now() + this.#ttlMs
    });
  }

  verify(verification: TerminalEvidenceVerification): boolean {
    const authorized = this.#authorized.get(verification.environmentId);
    if (authorized === undefined) return false;
    this.#authorized.delete(verification.environmentId);
    return authorized.expiresAt > this.#now() && sameEvidence(authorized.request, verification);
  }
}
