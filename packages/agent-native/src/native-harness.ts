import { createSessionEventRelay, type SessionEventRelay } from "@autostack/agent-runtime";
import {
  AgentCancelRequestSchema,
  AgentInvocationRequestSchema,
  AgentResumeRequestSchema,
  AgentSteerRequestSchema,
  admitAgentPermissionResponse,
  type AgentCancelRequest,
  type AgentHarnessPort,
  type AgentInvocationRequest,
  type AgentPermissionRequest,
  type AgentPermissionResponderPort,
  type AgentPermissionResponse,
  type AgentResumeRequest,
  type AgentSessionId,
  type AgentSessionStreamEvent,
  type AgentSteerRequest
} from "@autostack/contracts";

import {
  assertContextSourcesPermissible,
  assertSessionConfigCoherent,
  deriveNativeDescriptor,
  type NativeHarnessConfig,
  type NativeHarnessDeps
} from "./harness-config.js";
import { createNativeSessionState, superviseNativeSession } from "./native-session.js";

export type {
  NativeContextConfig,
  NativeHarnessConfig,
  NativeHarnessDeps,
  NativeRoleInput,
  NativeRoleInputsProvider,
  NativeSessionConfig
} from "./harness-config.js";

/**
 * The native adapter behind the vendor-neutral port. `respondToPermission` is present ONLY when
 * the configuration is permissioned, mirroring the contract's rule that adapters without the
 * capability must not implement `AgentPermissionResponderPort` — the honesty is structural.
 */
export interface NativeAgentHarness
  extends AgentHarnessPort, Partial<AgentPermissionResponderPort> {
  /** The request the session is currently blocked on, with the options it offered. */
  readonly pendingPermission: AgentPermissionRequest | undefined;
  /** Releases the session's resources. Idempotent. */
  dispose(): Promise<void>;
}

export const createNativeHarness = (
  config: NativeHarnessConfig,
  deps: NativeHarnessDeps
): NativeAgentHarness => {
  const descriptor = deriveNativeDescriptor(config);
  assertSessionConfigCoherent(config);
  assertContextSourcesPermissible(config);

  const state = createNativeSessionState();
  const waiters = new Set<() => void>();
  let relay: SessionEventRelay | undefined;
  let sessionId: AgentSessionId | undefined;
  /** Highest sequence handed out through the port, the cursor an honest resume continues from. */
  let lastDelivered = 0;

  const notify = (): void => {
    for (const waiter of [...waiters]) {
      waiters.delete(waiter);
      waiter();
    }
  };

  const waitUntil = async (satisfied: () => boolean): Promise<void> => {
    while (!satisfied()) {
      await new Promise<void>((resolve) => waiters.add(resolve));
    }
  };

  const requireUsable = (action: string): void => {
    if (state.disposed) {
      throw new TypeError(`A disposed native agent harness cannot ${action}.`);
    }
  };

  const requireLiveSession = (envelopeSessionId: AgentSessionId, action: string): void => {
    if (sessionId === undefined) {
      throw new TypeError(`The native agent harness has not started a session to ${action}.`);
    }
    if (envelopeSessionId !== sessionId) {
      throw new TypeError(`This native agent harness cannot ${action} a different agent session.`);
    }
  };

  const deliver = async function* (
    stream: AsyncIterable<AgentSessionStreamEvent>
  ): AsyncGenerator<AgentSessionStreamEvent> {
    for await (const event of stream) {
      if (event.sequence > lastDelivered) {
        lastDelivered = event.sequence;
      }
      yield event;
    }
  };

  const start = (request: AgentInvocationRequest): AsyncIterable<AgentSessionStreamEvent> => {
    requireUsable("start a session");
    const parsed = AgentInvocationRequestSchema.parse(request);
    if (relay !== undefined) {
      throw new TypeError("This native agent harness has already started its session.");
    }
    sessionId = parsed.agentSessionId;
    const sessionRelay = createSessionEventRelay({
      sessionId: parsed.agentSessionId,
      now: deps.now
    });
    relay = sessionRelay;
    // The producer launches here, supervised and independent of the reader: abandoning the
    // returned iterable never stops the session, which is what an honest resume relies on.
    superviseNativeSession({
      config,
      deps,
      invocation: parsed,
      relay: sessionRelay,
      state,
      waitUntil
    });
    return deliver(sessionRelay.read());
  };

  const resume = (request: AgentResumeRequest): AsyncIterable<AgentSessionStreamEvent> =>
    (async function* () {
      requireUsable("resume a session");
      if (!descriptor.capabilities.resume) {
        throw new TypeError("This native agent harness does not declare resume support.");
      }
      const parsed = AgentResumeRequestSchema.parse(request);
      requireLiveSession(parsed.sessionId, "resume");
      if (state.cancelled) {
        throw new TypeError("A cancelled native agent session cannot be resumed.");
      }
      if (relay === undefined) {
        throw new TypeError("The native agent harness has not started a session to resume.");
      }
      // The continuation of the SAME session: the same relay, read from the delivery cursor.
      yield* deliver(relay.read({ after: lastDelivered }));
    })();

  const steer = async (request: AgentSteerRequest): Promise<void> => {
    requireUsable("accept steering");
    if (!descriptor.capabilities.steering) {
      throw new TypeError("This native agent harness does not declare steering support.");
    }
    const parsed = AgentSteerRequestSchema.parse(request);
    requireLiveSession(parsed.sessionId, "steer");
    if (relay === undefined || relay.state !== "open") {
      throw new TypeError("This native agent session is no longer accepting steering.");
    }
    state.steered.push(parsed.instruction);
    notify();
  };

  const cancel = async (request: AgentCancelRequest): Promise<void> => {
    requireUsable("cancel a session");
    const parsed = AgentCancelRequestSchema.parse(request);
    requireLiveSession(parsed.sessionId, "cancel");
    if (state.cancelled) {
      return;
    }
    state.cancelled = true;
    // Cancellation must land even while the producer is stuck inside a provider call it cannot
    // abandon, so the terminal is appended here; the producer's own appends then stand down.
    if (relay !== undefined && relay.state === "open") {
      relay.append({ type: "cancelled" });
    }
    notify();
  };

  const respondToPermission = async (response: AgentPermissionResponse): Promise<void> => {
    requireUsable("answer a permission request");
    if (state.pendingPermission === undefined) {
      throw new TypeError("The native agent harness has no outstanding permission request.");
    }
    const admitted = admitAgentPermissionResponse(state.pendingPermission, response);
    state.decision = admitted.response;
    notify();
  };

  const dispose = async (): Promise<void> => {
    if (state.disposed) {
      return;
    }
    state.disposed = true;
    relay?.close();
    notify();
  };

  return {
    descriptor,
    get pendingPermission() {
      return state.pendingPermission;
    },
    start,
    resume,
    steer,
    cancel,
    dispose,
    ...(descriptor.capabilities.permissions ? { respondToPermission } : {})
  };
};
