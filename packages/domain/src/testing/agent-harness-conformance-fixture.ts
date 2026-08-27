import type {
  AgentCancelRequest,
  AgentHarnessPort,
  AgentInvocationRequest,
  AgentPermissionRequest,
  AgentPermissionResponderPort,
  AgentPermissionResponse,
  AgentResumeRequest,
  AgentSessionStreamEvent,
  AgentSteerRequest
} from "@autostack/contracts";

/**
 * The scripted situations one conformance run needs an adapter to reproduce. A scenario is chosen
 * when the subject is created rather than triggered on a live subject, because an out-of-process
 * adapter replays one recorded transcript per subject and cannot branch mid-session.
 *
 * Obligations a fixture takes on per scenario — the suite asserts against these, so an adapter that
 * cannot produce one of them is not conformant:
 *
 * - `completes`: runs to exactly one `completed` event, and emits at least one `usage` event in
 *   which every figure the provider did not report is recorded as `{ state: "unknown" }`. At least
 *   one such unreported figure must exist, so the suite can tell an unknown from a fabricated zero.
 * - `pauses`: emits at least one event, then blocks indefinitely until the consumer steers it
 *   (full capability) or cancels it. A steered subject must make the steered instruction text
 *   observable in a later event.
 * - `requests_permission`: emits a `permission_requested` event, then blocks until the decision
 *   arrives, gating at least one observable side effect (`tool_call`, `file_change`, or the
 *   terminal event) behind it. The request must offer an `allow_once` or `allow_always` option.
 * - `fails`: terminates in a `failed` event whose `code` classifies the failure for the retry
 *   policy, and which is classified identically every time the same scenario is replayed. The code
 *   must already be in the workflow-failure alphabet — `^[a-z][a-z0-9_]{0,63}$`, lowercase
 *   snake_case, at most 64 characters — so that lifting it into `WorkflowFailure` for the retry
 *   policy is a no-op normalization. A JSON-RPC numeric code such as `-32601` does not survive
 *   that normalization, so an ACP adapter must map such codes to the alphabet before emitting.
 * - `interrupted`: emits at least one evidence-bearing event, then an `interrupted` event carrying
 *   the digests of that partial evidence, and ends without a lifecycle terminal (spec §15).
 */
export const AGENT_HARNESS_CONFORMANCE_SCENARIOS = [
  "completes",
  "pauses",
  "requests_permission",
  "fails",
  "interrupted"
] as const;

export type AgentHarnessConformanceScenario = (typeof AGENT_HARNESS_CONFORMANCE_SCENARIOS)[number];

/**
 * A minimal-capability descriptor declares `permissions: false`, and the contract forbids such an
 * adapter from implementing `AgentPermissionResponderPort`, so it can never answer a permission
 * request. Excluding the scenario keeps that rule structural instead of a runtime convention.
 */
export type AgentHarnessMinimalScenario = Exclude<
  AgentHarnessConformanceScenario,
  "requests_permission"
>;

/**
 * One harness under test plus the envelopes only its owner can mint. Identifiers, idempotency keys,
 * evidence digests, and the clock behind them belong to the fixture; the suite never fabricates
 * them. Everything else the suite learns through the port.
 *
 * `harness` is typed as the port plus an optional responder so the suite can probe for
 * `respondToPermission` structurally. A fixture must expose the adapter object itself here, never a
 * wrapper that adds or hides that method, or descriptor honesty becomes untestable.
 */
export interface AgentHarnessConformanceSubject {
  readonly harness: AgentHarnessPort & Partial<AgentPermissionResponderPort>;
  /** Starts this subject's session; its `agentSessionId` is the identity resume must preserve. */
  readonly invocation: AgentInvocationRequest;
  readonly steer: AgentSteerRequest;
  readonly cancel: AgentCancelRequest;
  /** Resume envelope for the started session, derived from whatever the stream disclosed. */
  resumeRequest(observed: readonly AgentSessionStreamEvent[]): AgentResumeRequest;
  /** The permission the session is blocked on, with the options it offered, or `undefined`. */
  pendingPermission(): Promise<AgentPermissionRequest | undefined>;
  /** An otherwise admissible decision on `request` selecting `selectedOptionId`. */
  permissionResponse(
    request: AgentPermissionRequest,
    selectedOptionId: string
  ): AgentPermissionResponse;
  /**
   * Resolves once the adapter has had every opportunity to deliver a frame it already holds.
   *
   * The suite judges a session "paused" by observing that an outstanding pull has not settled. That
   * judgement is only sound if the adapter's transport has been given time to run: an in-process
   * fake resolves its waiters on the microtask queue, while a CLI adapter delivers each frame on a
   * macrotask. A fixture whose transport needs more than a microtask drain must implement this and
   * resolve only after its own delivery mechanism has quiesced, or a session that is merely slow
   * will be mistaken for one that is waiting on the consumer.
   *
   * Omit it to accept the in-process default (a bounded microtask drain).
   */
  quiesce?(): Promise<void>;
  /** Releases the subject's resources. Must be idempotent. */
  dispose(): Promise<void>;
}

/**
 * Produces fresh subjects. Each call returns an unstarted harness with its own session identity, so
 * one behaviour never observes another's state.
 *
 * The full-capability descriptor must declare `resume`, `steering`, and `permissions`; the minimal
 * one must declare all three false. The suite relies on that split to tell a genuinely unsupported
 * operation from a broken one.
 *
 * `structuredPlans` is deliberately unconstrained in both. A real adapter ships one fixed
 * descriptor, so requiring the full subject to declare a capability the suite never exercises would
 * lock out an otherwise conformant harness that simply has no structured plans to emit. The suite
 * holds it to a one-directional honesty rule instead: a subject that declares `structuredPlans:
 * false` must never emit a `plan` event.
 */
export interface AgentHarnessConformanceFixture {
  createFullCapabilityHarness(
    scenario: AgentHarnessConformanceScenario
  ): Promise<AgentHarnessConformanceSubject>;
  createMinimalCapabilityHarness(
    scenario: AgentHarnessMinimalScenario
  ): Promise<AgentHarnessConformanceSubject>;
}
