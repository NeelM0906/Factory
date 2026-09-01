import {
  digestVersionedValue,
  type AgentSessionId,
  type AgentSessionStreamEvent
} from "@autostack/contracts";

import type { SessionEventTemplate } from "./session-event-relay.js";

/**
 * SINGLE AUTHORITY for the partial-transcript digest: the adapter (`agent-native`'s host-loss
 * path) and the supervisor's synthesized interruption both digest under this domain with the
 * same `{ sessionId, events }` projection, imported from here — a duplicated literal is how two
 * interruption owners silently stop agreeing on what the evidence of a lost session looks like.
 */
export const AGENT_SESSION_TRANSCRIPT_DIGEST_DOMAIN = "autostack.agent-session-transcript";

/** Digests a session's partial transcript under the shared domain and projection. */
export const digestSessionTranscript = (options: {
  readonly sessionId: AgentSessionId;
  readonly events: readonly AgentSessionStreamEvent[];
}): Promise<string> =>
  digestVersionedValue(AGENT_SESSION_TRANSCRIPT_DIGEST_DOMAIN, {
    sessionId: options.sessionId,
    events: options.events
  });

export interface InterruptionTemplateOptions {
  readonly sessionId: AgentSessionId;
  /** Every event relayed so far, in relay-stamped form: the partial evidence of the session. */
  readonly transcript: readonly AgentSessionStreamEvent[];
  readonly reason: string;
}

/**
 * Builds the ONE `interrupted` event a supervisor may synthesize, carrying the digest of the
 * partial transcript so the evidence gathered before the loss stays addressable
 * (`evidenceDigests` has `min(1)`; the transcript digest is the floor for a session with no
 * other evidence yet). Interruption is environmental and re-runnable, hence `retryable: true`.
 */
export const buildInterruptionTemplate = async (
  options: InterruptionTemplateOptions
): Promise<SessionEventTemplate> => {
  const transcriptDigest = await digestSessionTranscript({
    sessionId: options.sessionId,
    events: options.transcript
  });
  return {
    type: "interrupted",
    reason: options.reason,
    retryable: true,
    evidenceDigests: [transcriptDigest]
  };
};
