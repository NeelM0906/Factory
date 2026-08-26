import {
  AgentCancelRequestSchema,
  AgentHarnessDescriptorSchema,
  AgentInvocationRequestSchema,
  AgentPermissionRequestSchema,
  AgentResumeRequestSchema,
  AgentSessionEventSchema,
  AgentSteerRequestSchema,
  admitAgentPermissionResponse,
  type AgentCancelRequest,
  type AgentHarnessDescriptor,
  type AgentHarnessPort,
  type AgentInvocationRequest,
  type AgentPermissionRequest,
  type AgentPermissionResponderPort,
  type AgentPermissionResponse,
  type AgentResumeRequest,
  type AgentSessionEvent,
  type AgentSessionId,
  type AgentSteerRequest
} from "@autostack/contracts";

import type { FakeHarnessEventTemplate, FakeHarnessScript } from "./fake-agent-harness-script.js";

export interface FakeAgentHarnessDescriptorOverrides {
  readonly adapterId?: string;
  readonly kind?: AgentHarnessDescriptor["kind"];
  readonly displayName?: string;
  readonly capabilities?: Partial<AgentHarnessDescriptor["capabilities"]>;
}

export interface FakeAgentHarnessOptions {
  readonly script: FakeHarnessScript;
  readonly now: () => string;
  readonly providerSessionRef: () => string;
  readonly descriptor?: FakeAgentHarnessDescriptorOverrides;
}

/** Introspection is read-only: a consumer drives the fake through the port, never through state. */
export interface FakeAgentHarness extends AgentHarnessPort, AgentPermissionResponderPort {
  readonly sentMessages: readonly AgentSteerRequest[];
  readonly permissionResponses: readonly AgentPermissionResponse[];
  readonly disposed: boolean;
  dispose(): Promise<void>;
}

const DEFAULT_DESCRIPTOR = {
  schemaVersion: 1,
  adapterId: "fake.agent-harness",
  kind: "native",
  displayName: "Fake Agent Harness",
  capabilities: { resume: true, steering: true, permissions: true, structuredPlans: true }
} as const;

export const createFakeAgentHarness = (options: FakeAgentHarnessOptions): FakeAgentHarness => {
  const overrides = options.descriptor;
  const descriptor = AgentHarnessDescriptorSchema.parse({
    ...DEFAULT_DESCRIPTOR,
    ...overrides,
    capabilities: { ...DEFAULT_DESCRIPTOR.capabilities, ...overrides?.capabilities }
  });

  const script = options.script;
  const sentMessages: AgentSteerRequest[] = [];
  const permissionResponses: AgentPermissionResponse[] = [];
  const waiters = new Set<() => void>();
  let cursor = 0;
  let sequence = 0;
  let sessionId: AgentSessionId | undefined;
  let cancelled = false;
  let disposed = false;
  let consumedSteers = 0;
  let consumedPermissions = 0;
  let pendingPermission: AgentPermissionRequest | undefined;

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

  const withProviderSessionRef = (template: FakeHarnessEventTemplate): FakeHarnessEventTemplate =>
    template.type === "started" && template.providerSessionRef === undefined
      ? { ...template, providerSessionRef: options.providerSessionRef() }
      : template;

  const nextEvent = (
    template: FakeHarnessEventTemplate,
    session: AgentSessionId
  ): AgentSessionEvent => {
    sequence += 1;
    return AgentSessionEventSchema.parse({
      ...withProviderSessionRef(template),
      schemaVersion: 1,
      sessionId: session,
      sequence,
      occurredAt: options.now()
    });
  };

  const requireLiveSession = (envelopeSessionId: AgentSessionId, action: string): void => {
    if (sessionId === undefined) {
      throw new TypeError(`The fake agent harness has not started a session to ${action}.`);
    }
    if (envelopeSessionId !== sessionId) {
      throw new TypeError(`This fake agent harness cannot ${action} a different agent session.`);
    }
  };

  const requireUsable = (action: string): void => {
    if (disposed) throw new TypeError(`A disposed fake agent harness cannot ${action}.`);
  };

  const runScript = async function* (session: AgentSessionId): AsyncGenerator<AgentSessionEvent> {
    while (cursor < script.length) {
      if (disposed) return;
      if (cancelled) {
        yield nextEvent({ type: "cancelled" }, session);
        return;
      }
      const step = script[cursor];
      if (step === undefined) return;
      cursor += 1;

      if (step.kind === "emit") {
        yield nextEvent(step.event, session);
        continue;
      }
      if (step.kind === "throw") {
        throw step.error;
      }
      if (step.kind === "await_steer") {
        yield nextEvent({ type: "waiting", reason: step.reason }, session);
        await waitUntil(() => cancelled || disposed || sentMessages.length > consumedSteers);
        if (disposed) return;
        if (cancelled) {
          yield nextEvent({ type: "cancelled" }, session);
          return;
        }
        consumedSteers += 1;
        continue;
      }

      const request = AgentPermissionRequestSchema.parse({
        schemaVersion: 1,
        sessionId: session,
        permissionRef: step.permission.permissionRef,
        summary: step.permission.summary,
        evidenceDigest: step.permission.evidenceDigest,
        options: step.permission.options,
        requestedAt: options.now()
      });
      pendingPermission = request;
      yield nextEvent(
        {
          type: "permission_requested",
          permissionRef: request.permissionRef,
          summary: request.summary,
          evidenceDigest: request.evidenceDigest
        },
        session
      );
      await waitUntil(
        () => cancelled || disposed || permissionResponses.length > consumedPermissions
      );
      pendingPermission = undefined;
      if (disposed) return;
      if (cancelled) {
        yield nextEvent({ type: "cancelled" }, session);
        return;
      }
      consumedPermissions += 1;
    }
  };

  const start = (request: AgentInvocationRequest): AsyncIterable<AgentSessionEvent> =>
    (async function* () {
      requireUsable("start a session");
      const parsed = AgentInvocationRequestSchema.parse(request);
      if (sessionId !== undefined) {
        throw new TypeError("This fake agent harness has already started its session.");
      }
      sessionId = parsed.agentSessionId;
      yield* runScript(parsed.agentSessionId);
    })();

  const resume = (request: AgentResumeRequest): AsyncIterable<AgentSessionEvent> =>
    (async function* () {
      requireUsable("resume a session");
      if (!descriptor.capabilities.resume) {
        throw new TypeError("This fake agent harness does not declare resume support.");
      }
      const parsed = AgentResumeRequestSchema.parse(request);
      requireLiveSession(parsed.sessionId, "resume");
      if (cancelled) {
        throw new TypeError("A cancelled agent session cannot be resumed.");
      }
      yield* runScript(parsed.sessionId);
    })();

  const steer = async (request: AgentSteerRequest): Promise<void> => {
    requireUsable("accept steering");
    if (!descriptor.capabilities.steering) {
      throw new TypeError("This fake agent harness does not declare steering support.");
    }
    const parsed = AgentSteerRequestSchema.parse(request);
    requireLiveSession(parsed.sessionId, "steer");
    sentMessages.push(parsed);
    notify();
  };

  const cancel = async (request: AgentCancelRequest): Promise<void> => {
    requireUsable("cancel a session");
    const parsed = AgentCancelRequestSchema.parse(request);
    requireLiveSession(parsed.sessionId, "cancel");
    cancelled = true;
    notify();
  };

  const respondToPermission = async (response: AgentPermissionResponse): Promise<void> => {
    requireUsable("answer a permission request");
    if (!descriptor.capabilities.permissions) {
      throw new TypeError("This fake agent harness does not declare permission support.");
    }
    if (pendingPermission === undefined) {
      throw new TypeError("The fake agent harness has no outstanding permission request.");
    }
    const admitted = admitAgentPermissionResponse(pendingPermission, response);
    permissionResponses.push(admitted.response);
    notify();
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    notify();
  };

  return {
    descriptor,
    get sentMessages() {
      return [...sentMessages];
    },
    get permissionResponses() {
      return [...permissionResponses];
    },
    get disposed() {
      return disposed;
    },
    start,
    resume,
    steer,
    cancel,
    respondToPermission,
    dispose
  };
};
