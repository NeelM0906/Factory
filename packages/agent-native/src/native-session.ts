import {
  digestSessionTranscript,
  type SessionEventRelay,
  type SessionEventTemplate
} from "@autostack/agent-runtime";
import {
  AgentPermissionRequestSchema,
  ModelInferenceRequestSchema,
  ModelRouteContextSchema,
  StationProvenanceSchema,
  redactSensitiveText,
  type AgentInvocationRequest,
  type AgentPermissionRequest,
  type AgentPermissionResponse,
  type AgentSessionStreamEvent,
  type ModelInferenceResult,
  type ModelMessage,
  type ModelRouteSelection
} from "@autostack/contracts";

import { assembleContext, type OutOfScopeRead } from "./context-assembly.js";
import { NativeAgentError, type NativeAgentFailure } from "./errors.js";
import { classifyThrowable } from "./failure-classification.js";
import { type NativeHarnessConfig, type NativeHarnessDeps } from "./harness-config.js";
import { buildRepositoryContext } from "./repository-context.js";
import { NATIVE_ROLE_CONFIGS, type NativeRoleConfig } from "./roles/role-config.js";
import { admitStructuredOutput } from "./structured-output.js";

/** Ceiling on echoed model text inside a `message` event; the full document travels as evidence. */
const MESSAGE_TEXT_CEILING = 20_000;

/** Control-flow signal: the consumer cancelled the session; the terminal is `cancelled`. */
class SessionCancelledSignal extends Error {
  constructor() {
    super("The native agent session was cancelled.");
    this.name = "SessionCancelledSignal";
  }
}

/** Control-flow signal: the session's relay is no longer accepting events; stop silently. */
class SessionDetachedSignal extends Error {
  constructor() {
    super("The native agent session is detached from its relay.");
    this.name = "SessionDetachedSignal";
  }
}

/** Mutable per-session state shared between the harness port surface and the producer. */
export interface NativeSessionState {
  cancelled: boolean;
  disposed: boolean;
  pendingPermission: AgentPermissionRequest | undefined;
  decision: AgentPermissionResponse | undefined;
  lastPermissionRequested:
    | { readonly permissionRef: string; readonly summary: string; readonly evidenceDigest: string }
    | undefined;
  readonly steered: string[];
  readonly transcript: AgentSessionStreamEvent[];
}

export const createNativeSessionState = (): NativeSessionState => ({
  cancelled: false,
  disposed: false,
  pendingPermission: undefined,
  decision: undefined,
  lastPermissionRequested: undefined,
  steered: [],
  transcript: []
});

export interface NativeSessionContext {
  readonly config: NativeHarnessConfig;
  readonly deps: NativeHarnessDeps;
  readonly invocation: AgentInvocationRequest;
  readonly relay: SessionEventRelay;
  readonly state: NativeSessionState;
  readonly waitUntil: (satisfied: () => boolean) => Promise<void>;
}

type Appender = (template: SessionEventTemplate) => void;

const failureOf = (thrown: unknown): NativeAgentFailure =>
  thrown instanceof NativeAgentError
    ? { code: thrown.code, message: thrown.message, retryable: thrown.retryable }
    : classifyThrowable(thrown);

const repairMessages = (
  messages: readonly ModelMessage[],
  schemaPaths: readonly string[]
): readonly ModelMessage[] => [
  ...messages,
  {
    role: "user",
    content: `The previous reply failed schema admission at: ${
      schemaPaths.length > 0 ? schemaPaths.join(", ") : "(root)"
    }. Reply again with one JSON object that satisfies the schema in the system message.`
  }
];

const captureRequestedPermission = (
  state: NativeSessionState,
  template: SessionEventTemplate
): void => {
  if (template.type === "permission_requested") {
    state.lastPermissionRequested = {
      permissionRef: template.permissionRef,
      summary: template.summary,
      evidenceDigest: template.evidenceDigest
    };
  }
};

/**
 * Puts one out-of-scope read to the port's permission surface and blocks until it is decided.
 * The pending request reuses the permissionRef and evidence digest of the `permission_requested`
 * event context assembly just emitted, so the port answers exactly what the stream announced.
 */
const makePermissionGate =
  (context: NativeSessionContext) =>
  async (read: OutOfScopeRead): Promise<"allow" | "deny"> => {
    const { deps, invocation, state } = context;
    const requested = state.lastPermissionRequested;
    if (requested === undefined || requested.permissionRef !== read.permissionRef) {
      throw new NativeAgentError("native_agent_internal_error");
    }
    const request = AgentPermissionRequestSchema.parse({
      schemaVersion: 1,
      sessionId: invocation.agentSessionId,
      permissionRef: read.permissionRef,
      summary: requested.summary,
      evidenceDigest: requested.evidenceDigest,
      options: read.options,
      requestedAt: deps.now()
    });
    state.pendingPermission = request;
    try {
      await context.waitUntil(
        () => state.cancelled || state.disposed || state.decision !== undefined
      );
    } finally {
      state.pendingPermission = undefined;
    }
    if (state.cancelled) throw new SessionCancelledSignal();
    if (state.disposed) throw new SessionDetachedSignal();
    const decision = state.decision;
    state.decision = undefined;
    if (decision === undefined) {
      throw new NativeAgentError("native_agent_internal_error");
    }
    const selected = request.options.find(
      (option) => option.optionId === decision.selectedOptionId
    );
    return selected !== undefined &&
      (selected.kind === "allow_once" || selected.kind === "allow_always")
      ? "allow"
      : "deny";
  };

/**
 * The engine's interactive wait: after context assembly and before the model call, the session
 * announces `waiting` and blocks for one operator instruction, which is echoed as a `message`
 * and folded into the prompt. Entered ONLY when the configuration declares an interactive
 * session; a merely steerable one folds in a steer that already arrived without waiting.
 */
const awaitSteer = async (context: NativeSessionContext, append: Appender): Promise<string> => {
  const { state } = context;
  append({ type: "waiting", reason: "Awaiting an operator instruction before the model call." });
  await context.waitUntil(() => state.cancelled || state.disposed || state.steered.length > 0);
  if (state.cancelled) throw new SessionCancelledSignal();
  if (state.disposed) throw new SessionDetachedSignal();
  const instruction = state.steered.shift();
  if (instruction === undefined) {
    throw new NativeAgentError("native_agent_internal_error");
  }
  append({ type: "message", role: "user", text: instruction });
  return instruction;
};

/** Folds in a steer that arrived before the model call, without ever blocking for one. */
const takeQueuedSteer = (context: NativeSessionContext, append: Appender): string | undefined => {
  const instruction = context.state.steered.shift();
  if (instruction === undefined) {
    return undefined;
  }
  append({ type: "message", role: "user", text: instruction });
  return instruction;
};

const resolveRoute = async (
  context: NativeSessionContext,
  role: NativeRoleConfig
): Promise<ModelRouteSelection> => {
  const { deps, invocation } = context;
  return deps.router.resolve(
    ModelRouteContextSchema.parse({
      schemaVersion: 1,
      idempotencyKey: `${invocation.idempotencyKey.slice(0, 200)}/route/1`,
      workspaceId: invocation.workspaceId,
      runId: invocation.runId,
      stageRunId: invocation.stageRunId,
      stage: role.stage,
      requiredCapabilities: [...role.requiredCapabilities]
    })
  );
};

const runSession = async (context: NativeSessionContext): Promise<void> => {
  const { config, deps, invocation, relay, state } = context;

  const append: Appender = (template) => {
    if (state.cancelled) throw new SessionCancelledSignal();
    if (state.disposed || relay.state !== "open") throw new SessionDetachedSignal();
    state.transcript.push(relay.append(template));
  };

  const role = NATIVE_ROLE_CONFIGS[config.role];

  // A station that writes a document carrying `workItemId` in its identity fails closed when it
  // is absent — the model must never supply identity for a document it authors (spec §14.1).
  const workItemId = invocation.workItemId;
  if (workItemId === undefined) {
    throw new NativeAgentError("native_invocation_incomplete");
  }

  append({ type: "started", providerSessionRef: deps.newProviderSessionRef() });

  const assembled = await assembleContext({
    paths: config.context.paths,
    scope: config.context.scope,
    deps: {
      reader: deps.reader,
      emit: (template) => {
        captureRequestedPermission(state, template);
        append(template);
      },
      limits: config.context.limits,
      newRef: deps.newRef,
      ...(config.permissioned ? { requestPermission: makePermissionGate(context) } : {})
    }
  });

  const steerText = config.session.interactive
    ? await awaitSteer(context, append)
    : config.session.steerable
      ? takeQueuedSteer(context, append)
      : undefined;

  const providedInputs = await deps.roleInputs.forInvocation(invocation);
  // Pre-model admission of the role's inputs (T10): runs BEFORE anything derived from them
  // exists — no rendered prompt, no route, no model call. Whatever the gate throws surfaces as
  // native_context_unavailable: unadmitted evidence is unavailable context, never a model fault.
  const inputs =
    role.admitRoleInputs === undefined
      ? providedInputs
      : await role.admitRoleInputs(providedInputs, invocation).catch((thrown: unknown) => {
          throw new NativeAgentError("native_context_unavailable", thrown);
        });
  const messages = role.prompt.render({
    objective: invocation.objective,
    repositoryContext: buildRepositoryContext(assembled, inputs, steerText)
  });

  const selection = await resolveRoute(context, role);
  let attempts = 0;
  const invoke = async (invokeMessages: readonly ModelMessage[]): Promise<ModelInferenceResult> => {
    attempts += 1;
    const result = await deps.inference.run(
      ModelInferenceRequestSchema.parse({
        schemaVersion: 1,
        idempotencyKey: `${invocation.idempotencyKey.slice(0, 200)}/model/${attempts}`,
        selection,
        messages: invokeMessages,
        options: {
          maxOutputTokens: role.maxOutputTokens,
          responseFormat: "json"
        }
      })
    );
    // Usage is recorded VERBATIM: unreported provider figures stay unknown, never zero.
    append({ type: "usage", tokens: result.tokens, cost: result.cost, model: result.actual.model });
    if (result.finishReason === "length") {
      // A truncated structured response is never a partial document; it failed to exist.
      throw new NativeAgentError("malformed_model_output");
    }
    return result;
  };

  const first = await invoke(messages);
  const outcome = await admitStructuredOutput({
    role: config.role,
    schema: role.outputSchema,
    responseText: first.content,
    policy: deps.structuredOutput,
    reask: async (schemaPaths) => (await invoke(repairMessages(messages, schemaPaths))).content
  });
  if (outcome.kind === "rejected") {
    append({
      type: "failed",
      code: outcome.failure.code,
      message: outcome.failure.message,
      retryable: outcome.failure.retryable
    });
    return;
  }

  // Invocation-scoped admission the static output schema cannot express (T9: the plan role's
  // credential scoping). Runs BEFORE the echo, the evidence pipeline, and any detail event, so a
  // refused response leaves no message, no plan event, and no completion behind it.
  const invalidity = role.validateModelAuthored?.(outcome.value, invocation, inputs);
  if (invalidity !== undefined) {
    append({
      type: "failed",
      code: invalidity.code,
      message: invalidity.message,
      retryable: invalidity.retryable
    });
    return;
  }

  append({
    type: "message",
    role: "assistant",
    text: redactSensitiveText(JSON.stringify(outcome.value)).slice(0, MESSAGE_TEXT_CEILING)
  });

  // The role's evidence pipeline (plan Tasks 8-9): identity comes from the INVOCATION, content
  // from the admitted model fields, provenance from the harness — prompt artifact, adapter, and
  // the route the router actually resolved. The build is awaited because the plan role computes
  // its self-digest inside it. The digest is recomputed as an admission gate before the
  // completion may carry it; a mismatch here is a contradiction the role itself produced, so it
  // classifies as an internal error, never as model fault.
  const producedBy = StationProvenanceSchema.parse({
    adapterId: config.adapterId,
    promptRef: role.prompt.promptRef,
    promptVersion: String(role.prompt.version),
    routeRef: selection.routeRef
  });
  const document = await role.buildDocument({
    identity: { workspaceId: invocation.workspaceId, workItemId, runId: invocation.runId },
    modelAuthored: outcome.value,
    producedAt: deps.now(),
    producedBy,
    roleInputs: inputs
  });
  const evidenceDigest = await role.digestDocument(document);
  await role.admitDocument(document, evidenceDigest);
  // A role that declares structured plans announces the ADMITTED document's digest and summary
  // as a `plan` detail event before the terminal — role-driven data, not per-role control flow.
  const planEvent = role.planEvent?.(document);
  if (planEvent !== undefined) {
    append({ type: "plan", planDigest: planEvent.planDigest, summary: planEvent.summary });
  }
  append({ type: "completed", evidenceDigests: [evidenceDigest] });
};

/** Terminates the stream for a throwable the producer did not survive, if anything still can. */
const concludeThrown = (context: NativeSessionContext, thrown: unknown): void => {
  const { relay } = context;
  if (thrown instanceof SessionDetachedSignal) return;
  if (relay.state !== "open") return;
  if (thrown instanceof SessionCancelledSignal) {
    relay.append({ type: "cancelled" });
    return;
  }
  const failure = failureOf(thrown);
  relay.append({
    type: "failed",
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable
  });
};

/**
 * Host loss ends the session in `interrupted` — its own outcome, distinct from failure and from
 * success (spec §15) — carrying the digest of the partial transcript so the evidence gathered
 * before the loss stays addressable. Nothing may follow it; the relay enforces that.
 */
const watchHostLoss = (context: NativeSessionContext): void => {
  const hostLoss = context.deps.hostLoss;
  if (hostLoss === undefined) return;
  void hostLoss.then(async () => {
    const { relay, state } = context;
    if (relay.state !== "open") return;
    const digest = await digestSessionTranscript({
      sessionId: context.invocation.agentSessionId,
      events: state.transcript
    });
    if (relay.state !== "open") return;
    relay.append({
      type: "interrupted",
      reason: "The agent host was lost before the session finished.",
      retryable: true,
      evidenceDigests: [digest]
    });
  });
};

/**
 * Runs the session as a supervised producer, independent of any reader: events land in the relay
 * whether or not a consumer is pulling, which is what makes resume a continuation of the same
 * session rather than a replay into a new one (spec §9.1).
 */
export const superviseNativeSession = (context: NativeSessionContext): void => {
  void runSession(context).catch((thrown: unknown) => {
    concludeThrown(context, thrown);
  });
  watchHostLoss(context);
};
