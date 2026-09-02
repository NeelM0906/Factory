/**
 * ACP harness — the AgentHarnessPort implementation for ACP agents.
 *
 * Composes: EventSequencer, AcpEventMapper, AcpFailureClassifier, ChildSession.
 * The harness launches an ACP agent as a child process, negotiates via JSON-RPC,
 * and normalizes the stdio stream into AgentSessionStreamEvent.
 *
 * Design:
 * - JSON-RPC request/response correlation by sequential integer ID
 * - Notifications streamed through the mapper during the prompt phase
 * - Permission gating: the harness injects permission_resolved when the consumer decides
 * - D-2: process death discriminator (signal + evidence -> interrupted, else failed)
 * - D-7: steer observability via injected user message event
 * - Conditional respondToPermission: only exists on instances where permissionsConfigured
 */

import {
  ChildSession,
  EventSequencer,
  buildChildEnvironment,
  type AgentEvidenceSink,
  type ChildSessionEvent
} from "@autostack/agent-adapter-kit";

import { mapAcpFrame, buildUnknownUsage, type AcpMapperContext } from "./acp-event-mapper.js";
import {
  negotiateAcpCapabilities,
  type AcpInitializeResult,
  type AcpSessionNewResult
} from "./acp-capabilities.js";
import { classifyAcpFailure } from "./acp-failures.js";

import {
  AgentSessionStreamEventSchema,
  admitAgentPermissionResponse,
  type AgentHarnessDescriptor,
  type AgentHarnessPort,
  type AgentPermissionResponderPort,
  type AgentPermissionRequest,
  type AgentPermissionResponse,
  type AgentInvocationRequest,
  type AgentResumeRequest,
  type AgentSteerRequest,
  type AgentCancelRequest,
  type AgentSessionStreamEvent
} from "@autostack/contracts";

// ---- Options ----

export interface AcpHarnessOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly evidenceSink: AgentEvidenceSink;
  readonly permissionsConfigured: boolean;
  readonly structuredPlans: boolean;
  /** Provider auth variable names to forward (D-5). */
  readonly providerAuthVariables?: readonly string[];
  /** Source environment for key-copy (defaults to process.env). */
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  /** Runtime limit in ms (default 300_000). */
  readonly runtimeLimitMs?: number;
  /** Progress timeout in ms (default 60_000). */
  readonly progressTimeoutMs?: number;
  /** Termination grace in ms (default 5_000). */
  readonly terminationGraceMs?: number;
  /** Override args when spawning for resume (separate resume transcript). */
  readonly resumeArgs?: readonly string[];
  /** Whether the agent supports resume (loadSession). Default false. */
  readonly resumeSupported?: boolean;
  /** Whether the harness supports steering. Default true (ACP always supports it). */
  readonly steeringSupported?: boolean;
}

// ---- Evidence-bearing event types ----

const EVIDENCE_TYPES: ReadonlySet<string> = new Set([
  "file_change", "tool_call", "message", "plan", "output", "thought_summary"
]);

// ---- ACP option kind → contract option kind ----

type ContractOptionKind = "allow_once" | "allow_always" | "deny_once" | "deny_always";
const ACP_OPTION_KIND_MAP: Readonly<Record<string, ContractOptionKind>> = {
  allow_once: "allow_once",
  allow_always: "allow_always",
  deny_once: "deny_once",
  deny_always: "deny_always",
  reject_once: "deny_once",
  reject_always: "deny_always"
};

const mapAcpOptionKind = (kind: string): ContractOptionKind =>
  ACP_OPTION_KIND_MAP[kind] ?? "deny_once";

// ---- AcpHarness ----

/**
 * When `permissionsConfigured` is true, the returned instance also implements
 * `AgentPermissionResponderPort` (has `respondToPermission`). When false, the
 * method is absent so the conformance suite's `"respondToPermission" in harness`
 * structural check reflects the descriptor honestly.
 */
export class AcpHarness implements AgentHarnessPort {
  readonly #options: AcpHarnessOptions;
  readonly #sequencer: EventSequencer;
  #descriptor: AgentHarnessDescriptor;
  #disposed = false;
  #started = false;
  #cancelled = false;
  #session: ChildSession | undefined;

  /** JSON-RPC request ID counter. */
  #nextRpcId = 1;

  /** Events injected by respondToPermission or steer, queued for the event loop. */
  readonly #injectedEvents: AgentSessionStreamEvent[] = [];

  /** Current permission request the session is blocked on. */
  #pendingPermission: AgentPermissionRequest | undefined;

  /** Session identity from the invocation. */
  #sessionId: string | undefined;
  /** ACP-side session ID from session/new or session/load. */
  #acpSessionId: string | undefined;
  /** Mapper context, built during start/resume. */
  #mapperContext: AcpMapperContext | undefined;
  /** Whether evidence-bearing events have been emitted (for D-2). */
  #hasEvidence = false;

  private constructor(options: AcpHarnessOptions) {
    this.#options = options;
    this.#sequencer = new EventSequencer();
    this.#descriptor = {
      schemaVersion: 1 as const,
      adapterId: "acp/unknown/full",
      kind: "acp",
      displayName: "ACP Agent",
      capabilities: {
        resume: options.resumeSupported ?? false,
        steering: options.steeringSupported ?? true,
        permissions: options.permissionsConfigured,
        structuredPlans: options.structuredPlans
      }
    };

    // D-12: respondToPermission only exists on instances with permission support.
    // The conformance suite checks `"respondToPermission" in harness`.
    if (options.permissionsConfigured) {
      (this as unknown as AgentPermissionResponderPort).respondToPermission =
        this.#handlePermissionResponse.bind(this);
    }
  }

  static create(options: AcpHarnessOptions): AcpHarness {
    return new AcpHarness(options);
  }

  get descriptor(): AgentHarnessDescriptor {
    return this.#descriptor;
  }

  /** Exposed for the conformance fixture to read the pending permission request. */
  get pendingPermission(): AgentPermissionRequest | undefined {
    return this.#pendingPermission;
  }

  // ---- Permission response (bound conditionally in constructor) ----

  async #handlePermissionResponse(response: AgentPermissionResponse): Promise<void> {
    this.#assertNotDisposed();
    const pending = this.#pendingPermission;
    if (pending == null) {
      throw new Error("No permission request is pending.");
    }

    // Validate the response against the pending request
    admitAgentPermissionResponse(pending, response);

    // Clear the pending permission
    this.#pendingPermission = undefined;

    // Send the decision to the child
    await this.#writeRpc({
      jsonrpc: "2.0",
      id: this.#nextRpcId++,
      method: "session/respond_permission",
      params: {
        sessionId: this.#acpSessionId,
        permissionRef: pending.permissionRef,
        selectedOptionId: response.selectedOptionId
      }
    });

    // Inject a permission_resolved event into the stream
    const ctx = this.#mapperContext!;
    const resolvedEvent = AgentSessionStreamEventSchema.parse({
      schemaVersion: 1,
      sessionId: ctx.sessionId,
      sequence: ctx.sequencer.next(),
      occurredAt: new Date().toISOString(),
      type: "permission_resolved",
      permissionRef: pending.permissionRef,
      selectedOptionId: response.selectedOptionId
    });
    this.#injectedEvents.push(resolvedEvent);
  }

  // ---- AgentHarnessPort ----

  async *start(request: AgentInvocationRequest): AsyncIterable<AgentSessionStreamEvent> {
    this.#assertNotDisposed();
    if (this.#started) {
      throw new Error("Session already started. Use resume() to continue.");
    }
    this.#started = true;
    this.#sessionId = request.agentSessionId;

    this.#spawnChild();
    const eventIterator = this.#session![Symbol.asyncIterator]();

    try {
      const initResult = await this.#negotiate(eventIterator, "initialize", {
        protocolVersion: 1,
        clientInfo: { name: "autostack", version: "0.1.0" }
      });

      const sessionResult = await this.#negotiate(eventIterator, "session/new", {
        systemPrompt: request.objective
      });
      this.#acpSessionId = (sessionResult as Record<string, unknown>).sessionId as string;

      const profile = negotiateAcpCapabilities(
        initResult as unknown as AcpInitializeResult,
        sessionResult as unknown as AcpSessionNewResult,
        { permissionsConfigured: this.#options.permissionsConfigured }
      );
      // Re-apply the steering override — the negotiated descriptor always
      // says true (ACP's session/prompt is the steer), but the harness
      // configuration may disable it for conformance.
      this.#descriptor = {
        ...profile.descriptor,
        capabilities: {
          ...profile.descriptor.capabilities,
          steering: this.#options.steeringSupported ?? true
        }
      };

      this.#mapperContext = {
        sessionId: request.agentSessionId,
        sequencer: this.#sequencer,
        evidenceSink: this.#options.evidenceSink,
        workspaceCwd: request.cwd,
        structuredPlans: this.#options.structuredPlans
      };

      yield AgentSessionStreamEventSchema.parse({
        schemaVersion: 1,
        sessionId: request.agentSessionId,
        sequence: this.#sequencer.next(),
        occurredAt: new Date().toISOString(),
        type: "started",
        providerSessionRef: this.#acpSessionId
      });

      await this.#writeRpc({
        jsonrpc: "2.0",
        id: this.#nextRpcId++,
        method: "session/prompt",
        params: { sessionId: this.#acpSessionId, prompt: request.objective }
      });

      yield* this.#streamEvents(eventIterator);
    } finally {
      if (this.#session && !this.#session.exited) {
        await this.#session.close();
      }
    }
  }

  async *resume(request: AgentResumeRequest): AsyncIterable<AgentSessionStreamEvent> {
    this.#assertNotDisposed();
    if (!this.#descriptor.capabilities.resume) {
      throw new Error("This harness does not support resume.");
    }
    this.#sessionId = request.sessionId;
    this.#cancelled = false;
    this.#hasEvidence = false;

    if (this.#session && !this.#session.exited) {
      await this.#session.close();
    }

    // Fresh child ⇒ fresh RPC ID space.
    this.#nextRpcId = 1;

    this.#spawnChild(this.#options.resumeArgs);
    const eventIterator = this.#session![Symbol.asyncIterator]();

    try {
      await this.#negotiate(eventIterator, "initialize", {
        protocolVersion: 1,
        clientInfo: { name: "autostack", version: "0.1.0" }
      });

      const sessionResult = await this.#negotiate(eventIterator, "session/load", {
        sessionId: request.providerSessionRef
      });
      this.#acpSessionId = (sessionResult as Record<string, unknown>).sessionId as string;

      this.#mapperContext = {
        sessionId: request.sessionId,
        sequencer: this.#sequencer,
        evidenceSink: this.#options.evidenceSink,
        workspaceCwd: this.#options.cwd,
        structuredPlans: this.#options.structuredPlans
      };

      await this.#writeRpc({
        jsonrpc: "2.0",
        id: this.#nextRpcId++,
        method: "session/prompt",
        params: { sessionId: this.#acpSessionId, prompt: request.objective }
      });

      yield* this.#streamEvents(eventIterator);
    } finally {
      if (this.#session && !this.#session.exited) {
        await this.#session.close();
      }
    }
  }

  async steer(request: AgentSteerRequest): Promise<void> {
    this.#assertNotDisposed();
    if (!this.#descriptor.capabilities.steering) {
      throw new Error("This harness does not support steering.");
    }
    if (!this.#session || this.#session.exited) {
      throw new Error("No active session to steer.");
    }

    // D-7: inject a user message so the instruction is observable in the stream
    const ctx = this.#mapperContext;
    if (ctx != null) {
      const messageEvent = AgentSessionStreamEventSchema.parse({
        schemaVersion: 1,
        sessionId: ctx.sessionId,
        sequence: ctx.sequencer.next(),
        occurredAt: new Date().toISOString(),
        type: "message",
        role: "user",
        text: request.instruction
      });
      this.#injectedEvents.push(messageEvent);
    }

    await this.#writeRpc({
      jsonrpc: "2.0",
      id: this.#nextRpcId++,
      method: "session/prompt",
      params: { sessionId: this.#acpSessionId, prompt: request.instruction }
    });
  }

  async cancel(_request: AgentCancelRequest): Promise<void> {
    this.#assertNotDisposed();
    this.#cancelled = true;
    if (this.#session && !this.#session.exited) {
      await this.#session.close();
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#session && !this.#session.exited) {
      await this.#session.close();
    }
  }

  /**
   * Quiesce: wait until the transport is genuinely idle.
   *
   * The conformance suite's pullUntilPaused calls quiesce concurrently with the
   * generator's first iteration. During negotiation the ChildSession's quiesce
   * may see zero activity (child not yet started) and declare stability before
   * the first event is yielded. To compensate, the harness loops on the
   * ChildSession's quiesce until negotiation completes (mapperContext is set)
   * or the child exits.
   */
  async quiesce(): Promise<void> {
    if (!this.#session) return;

    const deadline = Date.now() + 10_000;
    while (!this.#mapperContext && !this.#session.exited && Date.now() < deadline) {
      await this.#session.quiesce();
    }

    // One final quiesce to let post-negotiate events settle.
    await this.#session.quiesce();
  }

  // ---- Private helpers ----

  #assertNotDisposed(): void {
    if (this.#disposed) {
      throw new Error("AcpHarness has been disposed.");
    }
  }

  #spawnChild(overrideArgs?: readonly string[]): void {
    const env = buildChildEnvironment(
      (this.#options.sourceEnv ?? process.env) as Record<string, string>,
      this.#options.providerAuthVariables ?? []
    );

    this.#session = new ChildSession({
      executable: this.#options.executable,
      args: [...(overrideArgs ?? this.#options.args)],
      cwd: this.#options.cwd,
      env,
      runtimeLimitMs: this.#options.runtimeLimitMs ?? 300_000,
      progressTimeoutMs: this.#options.progressTimeoutMs ?? 60_000,
      terminationGraceMs: this.#options.terminationGraceMs ?? 5_000,
      quiesceFloorMs: 200
    });
  }

  async #writeRpc(message: Record<string, unknown>): Promise<void> {
    if (!this.#session || this.#session.exited) {
      throw new Error("Cannot write to exited child.");
    }
    await this.#session.write(JSON.stringify(message) + "\n");
  }

  async #negotiate(
    iterator: AsyncIterator<ChildSessionEvent>,
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const id = this.#nextRpcId++;
    await this.#writeRpc({ jsonrpc: "2.0", id, method, params });

    while (true) {
      const next = await iterator.next();
      if (next.done) {
        throw new Error(`Child exited during ${method} negotiation.`);
      }
      const event = next.value;
      if (event.kind === "stdout") {
        try {
          const frame = JSON.parse(event.line) as Record<string, unknown>;
          if (frame.id === id) {
            if (frame.error != null) {
              const error = frame.error as { message?: string };
              throw new Error(`${method} failed: ${error.message ?? "unknown error"}`);
            }
            return (frame.result ?? {}) as Record<string, unknown>;
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      } else if (event.kind === "exit") {
        throw new Error(
          `Child exited during ${method} negotiation (code=${event.code}, signal=${event.signal}).`
        );
      }
    }
  }

  async *#streamEvents(
    iterator: AsyncIterator<ChildSessionEvent>
  ): AsyncGenerator<AgentSessionStreamEvent> {
    const ctx = this.#mapperContext!;

    while (true) {
      while (this.#injectedEvents.length > 0) {
        yield this.#injectedEvents.shift()!;
      }

      const next = await iterator.next();
      if (next.done) break;

      // Drain injected events that arrived while awaiting (e.g., from steer
      // or respondToPermission called during a pullUntilPaused pause). Their
      // sequences were allocated before the mapper processes this frame, so
      // yielding them first preserves strict monotonic order.
      while (this.#injectedEvents.length > 0) {
        yield this.#injectedEvents.shift()!;
      }

      const event = next.value;

      if (event.kind === "stdout") {
        const mapped = await this.#handleStdout(event.line, ctx);
        for (const e of mapped) {
          this.#trackEvidence(e);

          if (e.type === "permission_requested" && this.#pendingPermission != null) {
            this.#pendingPermission = {
              ...this.#pendingPermission,
              evidenceDigest: e.evidenceDigest
            } as AgentPermissionRequest;
          }

          yield e;

          if (e.type === "completed" || e.type === "failed" || e.type === "cancelled") {
            while (this.#injectedEvents.length > 0) {
              yield this.#injectedEvents.shift()!;
            }
            return;
          }
        }
      } else if (event.kind === "stderr") {
        const mapped = await mapAcpFrame({ kind: "stderr", text: event.line }, ctx);
        for (const e of mapped) {
          this.#trackEvidence(e);
          yield e;
        }
      } else if (event.kind === "exit") {
        yield* this.#handleExit(event, ctx);
        return;
      }
    }
  }

  async #handleStdout(
    line: string,
    ctx: AcpMapperContext
  ): Promise<AgentSessionStreamEvent[]> {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }

    if (frame.method === "session/request_permission") {
      this.#capturePermissionRequest(frame);
    }

    // ACP v1 reports no usage; inject an all-unknown usage event before the mapper
    // produces the completed terminal (which marks the sequencer terminal).
    const result = frame.result as { stopReason?: string } | undefined;
    const events: AgentSessionStreamEvent[] = [];
    if (result != null && typeof result === "object" && result.stopReason != null) {
      events.push(
        AgentSessionStreamEventSchema.parse({
          schemaVersion: 1,
          sessionId: ctx.sessionId,
          sequence: ctx.sequencer.next(),
          occurredAt: new Date().toISOString(),
          type: "usage",
          ...buildUnknownUsage()
        })
      );
    }

    const mapped = await mapAcpFrame(frame, ctx);
    events.push(...mapped);
    return events;
  }

  #capturePermissionRequest(frame: Record<string, unknown>): void {
    const params = frame.params as Record<string, unknown> | undefined;
    if (params == null) return;

    const toolCall = params.toolCall as Record<string, unknown> | undefined;
    const options = params.options as Array<Record<string, unknown>> | undefined;
    if (toolCall == null || options == null) return;

    this.#pendingPermission = {
      schemaVersion: 1 as const,
      sessionId: this.#sessionId!,
      permissionRef: toolCall.toolCallId as string,
      summary: `Permission required: ${toolCall.title ?? "unknown"}`,
      evidenceDigest: "0".repeat(64),
      options: options.map((o) => ({
        optionId: o.optionId as string,
        kind: mapAcpOptionKind(o.kind as string),
        label: (o.name ?? o.label ?? "Unknown") as string
      })),
      requestedAt: new Date().toISOString()
    } as AgentPermissionRequest;
  }

  async *#handleExit(
    event: { readonly code: number | null; readonly signal: string | null },
    ctx: AcpMapperContext
  ): AsyncGenerator<AgentSessionStreamEvent> {
    if (this.#cancelled) {
      const cancelledCtx = {
        schemaVersion: 1 as const,
        sessionId: ctx.sessionId,
        sequence: ctx.sequencer.next(),
        occurredAt: new Date().toISOString()
      };
      ctx.sequencer.markTerminal();
      yield AgentSessionStreamEventSchema.parse({
        ...cancelledCtx,
        type: "cancelled"
      });
      return;
    }

    const classified = classifyAcpFailure({
      kind: "process_lost",
      hasEvidence: this.#hasEvidence,
      exitCode: event.code,
      signal: event.signal
    });

    if (classified.code === "interrupted") {
      const evidenceDigests = await this.#collectEvidenceDigests();
      yield AgentSessionStreamEventSchema.parse({
        schemaVersion: 1,
        sessionId: ctx.sessionId,
        sequence: ctx.sequencer.next(),
        occurredAt: new Date().toISOString(),
        type: "interrupted",
        reason: `Agent process terminated (signal=${event.signal ?? "unknown"}, code=${event.code ?? "unknown"}).`,
        retryable: true,
        evidenceDigests
      });
      ctx.sequencer.markInterrupted();
      return;
    }

    const failedCtx = {
      schemaVersion: 1 as const,
      sessionId: ctx.sessionId,
      sequence: ctx.sequencer.next(),
      occurredAt: new Date().toISOString()
    };
    ctx.sequencer.markTerminal();
    yield AgentSessionStreamEventSchema.parse({
      ...failedCtx,
      type: "failed",
      code: classified.code,
      message: `Agent process exited (code=${event.code ?? "unknown"}, signal=${event.signal ?? "unknown"}).`,
      retryable: classified.retryable ?? true
    });
  }

  #trackEvidence(event: AgentSessionStreamEvent): void {
    if (EVIDENCE_TYPES.has(event.type)) {
      this.#hasEvidence = true;
    }
  }

  async #collectEvidenceDigests(): Promise<string[]> {
    const { digest } = await this.#options.evidenceSink.record({
      kind: "transcript",
      bytes: new Uint8Array(Buffer.from(JSON.stringify({
        interrupted: true,
        at: new Date().toISOString()
      }), "utf8"))
    });
    return [digest];
  }
}
