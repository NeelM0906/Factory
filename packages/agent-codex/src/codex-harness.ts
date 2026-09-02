/**
 * Codex harness — the AgentHarnessPort implementation for Codex app-server.
 *
 * Composes: CodexJsonRpcClient, EventSequencer, CodexEventMapper,
 * CodexFailureClassifier, ChildSession.
 *
 * The harness launches Codex as a child process in app-server mode,
 * drives the JSON-RPC initialization handshake (initialize → thread/start
 * → turn/start), and normalizes the notification stream into
 * AgentSessionStreamEvent.
 *
 * Protocol:
 * - Outbound: JSON-RPC 2.0 requests on stdin (with `jsonrpc: "2.0"`)
 * - Inbound responses: {id, result} — no `jsonrpc` member
 * - Inbound notifications: {method, params, emittedAtMs}
 * - Permission channel: server→client request with `id`, answered on stdin
 * - Steering: turn/steer JSON-RPC request
 * - Cancellation: turn/interrupt JSON-RPC request
 * - Resume: thread/resume JSON-RPC request
 *
 * Design:
 * - D-2: process death discriminator (signal + evidence → interrupted, else failed)
 * - D-3: permission gating (no tool_call before permission_resolved)
 * - D-7: steer observability via injected user message event
 * - D-12: conditional respondToPermission
 */

import {
  ChildSession,
  EventSequencer,
  buildChildEnvironment,
  sanitizeTextField,
  type AgentEvidenceSink,
  type ChildSessionEvent
} from "@autostack/agent-adapter-kit";

import {
  mapCodexNotification,
  type CodexMapperContext
} from "./codex-event-mapper.js";

import { CodexJsonRpcClient, type CodexNotification } from "./codex-jsonrpc.js";
import { classifyCodexFailure } from "./codex-failures.js";

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

export interface CodexHarnessOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly evidenceSink: AgentEvidenceSink;
  readonly descriptor: AgentHarnessDescriptor;
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
}

// ---- Evidence-bearing event types ----

const EVIDENCE_TYPES: ReadonlySet<string> = new Set([
  "file_change", "tool_call", "message", "plan", "output", "thought_summary"
]);

// ---- CodexHarness ----

export class CodexHarness implements AgentHarnessPort {
  readonly #options: CodexHarnessOptions;
  readonly #sequencer: EventSequencer;
  readonly #descriptor: AgentHarnessDescriptor;
  #disposed = false;
  #started = false;
  #cancelled = false;
  #session: ChildSession | undefined;
  #rpcClient: CodexJsonRpcClient | undefined;

  /** Events injected by respondToPermission or steer, queued for the event loop. */
  readonly #injectedEvents: AgentSessionStreamEvent[] = [];

  /** Notifications buffered from the JSON-RPC client, drained by the event loop. */
  readonly #notificationBuffer: CodexNotification[] = [];

  /** Current permission request the session is blocked on. */
  #pendingPermission: AgentPermissionRequest | undefined;
  /** The JSON-RPC id of the pending approval request from Codex. */
  #pendingApprovalRpcId: number | undefined;

  /** Session identity from the invocation. */
  #sessionId: string | undefined;
  /** Mapper context, built during start. */
  #mapperContext: CodexMapperContext | undefined;
  /** Provider session ref (thread id). */
  #providerSessionRef: string | undefined;
  /** Whether evidence-bearing events have been emitted (for D-2). */
  #hasEvidence = false;

  private constructor(options: CodexHarnessOptions) {
    this.#options = options;
    this.#sequencer = new EventSequencer();
    this.#descriptor = options.descriptor;

    // D-12: respondToPermission only exists on instances with permission support.
    if (options.descriptor.capabilities.permissions) {
      (this as unknown as AgentPermissionResponderPort).respondToPermission =
        this.#handlePermissionResponse.bind(this);
    }
  }

  static create(options: CodexHarnessOptions): CodexHarness {
    return new CodexHarness(options);
  }

  get descriptor(): AgentHarnessDescriptor {
    return this.#descriptor;
  }

  /** Exposed for the conformance fixture to read the pending permission request. */
  get pendingPermission(): AgentPermissionRequest | undefined {
    return this.#pendingPermission;
  }

  // ---- Permission response ----

  async #handlePermissionResponse(response: AgentPermissionResponse): Promise<void> {
    this.#assertNotDisposed();
    const pending = this.#pendingPermission;
    if (pending == null) {
      throw new Error("No permission request is pending.");
    }

    // Validate the response against the pending request
    admitAgentPermissionResponse(pending, response);

    const rpcId = this.#pendingApprovalRpcId;

    // Clear the pending permission
    this.#pendingPermission = undefined;
    this.#pendingApprovalRpcId = undefined;

    // Send the JSON-RPC response back to Codex on stdin
    // Codex expects {jsonrpc, id, result: {decision: "accept"|"cancel"}}
    const decision = response.selectedOptionId === "allow" ? "accept" : "cancel";
    await this.#writeJson({
      jsonrpc: "2.0",
      id: rpcId,
      result: { decision }
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
    this.#createRpcClient();

    this.#mapperContext = {
      sessionId: request.agentSessionId,
      providerSessionRef: "",
      sequencer: this.#sequencer,
      evidenceSink: this.#options.evidenceSink,
      workspaceCwd: request.cwd
    };

    // Single iterator for the entire session (handshake + streaming)
    const eventIterator = this.#session![Symbol.asyncIterator]();

    // Drive the JSON-RPC handshake
    await this.#driveHandshake(request.objective, eventIterator);

    // Update mapper context with the provider session ref
    this.#mapperContext = {
      ...this.#mapperContext,
      providerSessionRef: this.#providerSessionRef ?? ""
    };

    // Emit started event
    const startedEvent = AgentSessionStreamEventSchema.parse({
      schemaVersion: 1,
      sessionId: request.agentSessionId,
      sequence: this.#sequencer.next(),
      occurredAt: new Date().toISOString(),
      type: "started",
      providerSessionRef: this.#providerSessionRef
    });
    yield startedEvent;

    try {
      yield* this.#streamEvents(eventIterator);
    } finally {
      this.#rpcClient?.close();
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
    this.#rpcClient?.close();

    this.#spawnChild();
    this.#createRpcClient();

    this.#mapperContext = {
      sessionId: request.sessionId,
      providerSessionRef: request.providerSessionRef,
      sequencer: this.#sequencer,
      evidenceSink: this.#options.evidenceSink,
      workspaceCwd: this.#options.cwd
    };

    this.#providerSessionRef = request.providerSessionRef;

    // Single iterator for the entire session
    const eventIterator = this.#session![Symbol.asyncIterator]();

    // Drive the resume handshake: initialize → thread/resume → turn/start
    await this.#driveResumeHandshake(request, eventIterator);

    // Emit started event
    const startedEvent = AgentSessionStreamEventSchema.parse({
      schemaVersion: 1,
      sessionId: request.sessionId,
      sequence: this.#sequencer.next(),
      occurredAt: new Date().toISOString(),
      type: "started",
      providerSessionRef: this.#providerSessionRef
    });
    yield startedEvent;

    try {
      yield* this.#streamEvents(eventIterator);
    } finally {
      this.#rpcClient?.close();
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

    // Send turn/steer to Codex
    await this.#rpcClient!.request("turn/steer", {
      instruction: request.instruction
    });
  }

  async cancel(_request: AgentCancelRequest): Promise<void> {
    this.#assertNotDisposed();
    this.#cancelled = true;

    // Close the child process. The #streamEvents loop detects the exit and
    // emits "cancelled" because #cancelled is true.
    // We do NOT await a turn/interrupt JSON-RPC response: the Codex fixture
    // (and possibly the real CLI) may not respond before exiting.
    this.#rpcClient?.close();
    if (this.#session && !this.#session.exited) {
      await this.#session.close();
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#rpcClient?.close();
    if (this.#session && !this.#session.exited) {
      await this.#session.close();
    }
  }

  /**
   * Quiesce: wait until the transport is genuinely idle.
   */
  async quiesce(): Promise<void> {
    if (!this.#session) return;
    await this.#session.quiesce();
  }

  // ---- Private helpers ----

  #assertNotDisposed(): void {
    if (this.#disposed) {
      throw new Error("CodexHarness has been disposed.");
    }
  }

  #spawnChild(): void {
    const env = buildChildEnvironment(
      (this.#options.sourceEnv ?? process.env) as Record<string, string>,
      this.#options.providerAuthVariables ?? []
    );

    this.#session = new ChildSession({
      executable: this.#options.executable,
      args: [...this.#options.args],
      cwd: this.#options.cwd,
      env,
      runtimeLimitMs: this.#options.runtimeLimitMs ?? 300_000,
      progressTimeoutMs: this.#options.progressTimeoutMs ?? 60_000,
      terminationGraceMs: this.#options.terminationGraceMs ?? 5_000,
      quiesceFloorMs: 200
    });
  }

  #createRpcClient(): void {
    this.#rpcClient = new CodexJsonRpcClient(
      async (data: string) => {
        if (!this.#session || this.#session.exited) {
          throw new Error("Cannot write to exited child.");
        }
        await this.#session.write(data + "\n");
      },
      (notification: CodexNotification) => {
        this.#notificationBuffer.push(notification);
      }
    );
  }

  async #writeJson(message: Record<string, unknown>): Promise<void> {
    if (!this.#session || this.#session.exited) {
      throw new Error("Cannot write to exited child.");
    }
    await this.#session.write(JSON.stringify(message) + "\n");
  }

  /**
   * Drive the Codex app-server handshake: initialize → thread/start → turn/start.
   * Uses the shared iterator to avoid splitting events across iterators.
   */
  async #driveHandshake(
    objective: string,
    iterator: AsyncIterator<ChildSessionEvent>
  ): Promise<void> {
    // Send initialize and pump the iterator until we get the response
    await this.#requestAndPump(iterator, "initialize", {});

    // Send thread/start and pump until response
    const threadResult = await this.#requestAndPump(
      iterator, "thread/start", { prompt: objective }
    ) as Record<string, unknown>;

    // Extract the thread id as provider session ref
    const thread = threadResult.thread as Record<string, unknown> | undefined;
    if (thread != null) {
      this.#providerSessionRef = thread.id as string;
    }

    // Send turn/start and pump until response
    await this.#requestAndPump(iterator, "turn/start", {});
  }

  /**
   * Drive the resume handshake: initialize → thread/resume → turn/start.
   */
  async #driveResumeHandshake(
    request: AgentResumeRequest,
    iterator: AsyncIterator<ChildSessionEvent>
  ): Promise<void> {
    await this.#requestAndPump(iterator, "initialize", {});

    await this.#requestAndPump(iterator, "thread/resume", {
      threadId: request.providerSessionRef,
      prompt: request.objective
    });

    await this.#requestAndPump(iterator, "turn/start", {});
  }

  /**
   * Send a JSON-RPC request and pump the child's iterator until the response
   * arrives. The RPC client registers the pending promise before writing, so
   * feeding the response frame via handleFrame resolves it.
   */
  async #requestAndPump(
    iterator: AsyncIterator<ChildSessionEvent>,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const resultPromise = this.#rpcClient!.request(method, params);

    // Pump stdout frames until the response resolves the promise
    const pump = async (): Promise<void> => {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;

        const event = next.value;
        if (event.kind === "stdout") {
          const frame = this.#tryParseFrame(event.line);
          if (frame != null) {
            this.#rpcClient!.handleFrame(frame);
            // If it was a response frame, the promise should now be resolved
            if ("id" in frame && typeof frame.id === "number") {
              return;
            }
          }
        }
      }
    };

    await pump();
    return await resultPromise;
  }

  #tryParseFrame(line: string): Record<string, unknown> | undefined {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  async *#streamEvents(
    iterator: AsyncIterator<ChildSessionEvent>
  ): AsyncGenerator<AgentSessionStreamEvent> {
    const ctx = this.#mapperContext!;

    while (true) {
      // Drain injected events
      while (this.#injectedEvents.length > 0) {
        yield this.#injectedEvents.shift()!;
      }

      // Drain notification buffer
      while (this.#notificationBuffer.length > 0) {
        const notification = this.#notificationBuffer.shift()!;
        const mapped = await this.#handleNotification(notification, ctx);
        for (const e of mapped) {
          this.#trackEvidence(e);
          this.#syncPermissionDigest(e);
          yield e;

          if (e.type === "completed" || e.type === "failed" || e.type === "cancelled") {
            while (this.#injectedEvents.length > 0) {
              yield this.#injectedEvents.shift()!;
            }
            return;
          }
        }
      }

      const next = await iterator.next();
      if (next.done) break;

      // Drain injected events that arrived while awaiting
      while (this.#injectedEvents.length > 0) {
        yield this.#injectedEvents.shift()!;
      }

      const event = next.value;

      if (event.kind === "stdout") {
        const frame = this.#tryParseFrame(event.line);
        if (frame != null) {
          // Feed to RPC client for response correlation + notification dispatch
          this.#rpcClient!.handleFrame(frame);

          // Also check for approval requests with an `id` (server→client requests)
          if ("id" in frame && typeof frame.id === "number" && "method" in frame) {
            this.#captureApprovalRequest(frame);
          }
        }

        // Process any notifications that were buffered by the callback
        while (this.#notificationBuffer.length > 0) {
          const notification = this.#notificationBuffer.shift()!;
          const mapped = await this.#handleNotification(notification, ctx);
          for (const e of mapped) {
            this.#trackEvidence(e);
            this.#syncPermissionDigest(e);
            yield e;

            if (e.type === "completed" || e.type === "failed" || e.type === "cancelled") {
              while (this.#injectedEvents.length > 0) {
                yield this.#injectedEvents.shift()!;
              }
              return;
            }
          }
        }
      } else if (event.kind === "exit") {
        yield* this.#handleExit(event, ctx);
        return;
      }
      // stderr is dropped for now — Codex doesn't use it meaningfully
    }
  }

  async #handleNotification(
    notification: CodexNotification,
    ctx: CodexMapperContext
  ): Promise<AgentSessionStreamEvent[]> {
    return await mapCodexNotification(notification, ctx);
  }

  #captureApprovalRequest(frame: Record<string, unknown>): void {
    const method = frame.method as string | undefined;
    if (method !== "item/commandExecution/requestApproval") return;

    const params = frame.params as Record<string, unknown> | undefined;
    if (params == null) return;

    const itemId = params.itemId as string | undefined;
    const reason = params.reason as string | undefined;

    if (itemId == null) return;

    this.#pendingApprovalRpcId = frame.id as number;

    const summary = sanitizeTextField(
      reason ?? "Permission required",
      { maxBytes: 2_000 }
    ) ?? "Permission required";

    this.#pendingPermission = {
      schemaVersion: 1 as const,
      sessionId: this.#sessionId!,
      permissionRef: itemId,
      summary,
      evidenceDigest: "0".repeat(64),
      options: [
        { optionId: "allow", kind: "allow_once" as const, label: "Allow" },
        { optionId: "allow_always", kind: "allow_always" as const, label: "Allow always" },
        { optionId: "deny", kind: "deny_once" as const, label: "Deny" }
      ],
      requestedAt: new Date().toISOString()
    } as AgentPermissionRequest;

    // Also push the notification to the mapper for the permission_requested event
    const notificationForMapper: CodexNotification = {
      method: "item/commandExecution/requestApproval",
      params
    };
    this.#notificationBuffer.push(notificationForMapper);
  }

  async *#handleExit(
    event: { readonly code: number | null; readonly signal: string | null },
    ctx: CodexMapperContext
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

    // Normal exit (code 0) — completed
    if (event.code === 0 && event.signal == null) {
      const evidenceDigests = await this.#collectEvidenceDigests();
      const completedCtx = {
        schemaVersion: 1 as const,
        sessionId: ctx.sessionId,
        sequence: ctx.sequencer.next(),
        occurredAt: new Date().toISOString()
      };
      ctx.sequencer.markTerminal();
      yield AgentSessionStreamEventSchema.parse({
        ...completedCtx,
        type: "completed",
        evidenceDigests
      });
      return;
    }

    const classified = classifyCodexFailure({
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
        reason: `Codex process terminated (signal=${event.signal ?? "unknown"}, code=${event.code ?? "unknown"}).`,
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
      message: `Codex process exited (code=${event.code ?? "unknown"}, signal=${event.signal ?? "unknown"}).`,
      retryable: classified.retryable ?? true
    });
  }

  #trackEvidence(event: AgentSessionStreamEvent): void {
    if (EVIDENCE_TYPES.has(event.type)) {
      this.#hasEvidence = true;
    }
  }

  /**
   * Sync the evidence digest from a permission_requested event to the captured
   * pending permission.
   */
  #syncPermissionDigest(event: AgentSessionStreamEvent): void {
    if (
      event.type === "permission_requested" &&
      this.#pendingPermission != null &&
      this.#pendingPermission.permissionRef === event.permissionRef
    ) {
      this.#pendingPermission = {
        ...this.#pendingPermission,
        evidenceDigest: event.evidenceDigest
      } as AgentPermissionRequest;
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
