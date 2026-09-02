/**
 * Claude Code harness — the AgentHarnessPort implementation for Claude Code.
 *
 * Composes: EventSequencer, ClaudeEventMapper, ClaudeFailureClassifier, ChildSession.
 * The harness launches Claude Code as a child process with `--output-format stream-json`,
 * and normalizes the stdio stream into AgentSessionStreamEvent.
 *
 * Protocol:
 * - Stdout: line-delimited JSON frames (system/init, assistant, user, result, etc.)
 * - Stdin: user messages for steering (JSON stream-json format), JSON-RPC responses for permissions
 * - Permission channel: JSON-RPC tools/call with name "approve" on stdout, response on stdin
 * - No negotiation phase (unlike ACP); first stdout line is system/init
 *
 * Design:
 * - D-2: process death discriminator (signal + evidence -> interrupted, else failed)
 * - D-3: permission gating (no tool_call before permission_resolved)
 * - D-7: steer observability via injected user message event
 * - Conditional respondToPermission: only on streaming profile with permissions
 */

import {
  ChildSession,
  EventSequencer,
  buildChildEnvironment,
  type AgentEvidenceSink,
  type ChildSessionEvent
} from "@autostack/agent-adapter-kit";

import {
  mapClaudeFrame,
  type ClaudeMapperContext
} from "./claude-event-mapper.js";
import { classifyClaudeFailure } from "./claude-failures.js";
import { classifyClaudeFrame, ClaudePermissionRequestSchema } from "./claude-frames.js";

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

export interface ClaudeHarnessOptions {
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
  /** The pinned provider session id (Claude Code session UUID). */
  readonly providerSessionId: string;
  /** Override args for resume (adds --resume). */
  readonly resumeArgs?: readonly string[];
}

// ---- Evidence-bearing event types ----

const EVIDENCE_TYPES: ReadonlySet<string> = new Set([
  "file_change", "tool_call", "message", "plan", "output", "thought_summary"
]);

// ---- ClaudeHarness ----

export class ClaudeHarness implements AgentHarnessPort {
  readonly #options: ClaudeHarnessOptions;
  readonly #sequencer: EventSequencer;
  readonly #descriptor: AgentHarnessDescriptor;
  #disposed = false;
  #started = false;
  #cancelled = false;
  #session: ChildSession | undefined;

  /** Events injected by respondToPermission or steer, queued for the event loop. */
  readonly #injectedEvents: AgentSessionStreamEvent[] = [];

  /** Current permission request the session is blocked on. */
  #pendingPermission: AgentPermissionRequest | undefined;
  /** The JSON-RPC id of the pending permission request. */
  #pendingPermissionRpcId: number | undefined;

  /** Session identity from the invocation. */
  #sessionId: string | undefined;
  /** Mapper context, built during start. */
  #mapperContext: ClaudeMapperContext | undefined;
  /** Whether evidence-bearing events have been emitted (for D-2). */
  #hasEvidence = false;

  private constructor(options: ClaudeHarnessOptions) {
    this.#options = options;
    this.#sequencer = new EventSequencer();
    this.#descriptor = options.descriptor;

    // D-12: respondToPermission only exists on instances with permission support.
    if (options.descriptor.capabilities.permissions) {
      (this as unknown as AgentPermissionResponderPort).respondToPermission =
        this.#handlePermissionResponse.bind(this);
    }
  }

  static create(options: ClaudeHarnessOptions): ClaudeHarness {
    return new ClaudeHarness(options);
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

    const rpcId = this.#pendingPermissionRpcId;

    // Clear the pending permission
    this.#pendingPermission = undefined;
    this.#pendingPermissionRpcId = undefined;

    // Send the JSON-RPC response back on stdin
    await this.#writeJson({
      jsonrpc: "2.0",
      id: rpcId,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ behavior: response.selectedOptionId === "allow" ? "allow" : "deny" })
          }
        ]
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

    this.#mapperContext = {
      sessionId: request.agentSessionId,
      providerSessionId: this.#options.providerSessionId,
      sequencer: this.#sequencer,
      evidenceSink: this.#options.evidenceSink,
      workspaceCwd: request.cwd,
      structuredPlans: this.#descriptor.capabilities.structuredPlans
    };

    // Write the objective as the first stdin line for Claude Code
    await this.#writeJson({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: request.objective }]
      }
    });

    const eventIterator = this.#session![Symbol.asyncIterator]();

    try {
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

    this.#spawnChild(this.#options.resumeArgs);

    this.#mapperContext = {
      sessionId: request.sessionId,
      providerSessionId: this.#options.providerSessionId,
      sequencer: this.#sequencer,
      evidenceSink: this.#options.evidenceSink,
      workspaceCwd: this.#options.cwd,
      structuredPlans: this.#descriptor.capabilities.structuredPlans
    };

    // Write the resume objective
    await this.#writeJson({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: request.objective }]
      }
    });

    const eventIterator = this.#session![Symbol.asyncIterator]();

    try {
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

    // Write the user message to stdin in stream-json format
    await this.#writeJson({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: request.instruction }]
      }
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
   */
  async quiesce(): Promise<void> {
    if (!this.#session) return;
    await this.#session.quiesce();
  }

  // ---- Private helpers ----

  #assertNotDisposed(): void {
    if (this.#disposed) {
      throw new Error("ClaudeHarness has been disposed.");
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

  async #writeJson(message: Record<string, unknown>): Promise<void> {
    if (!this.#session || this.#session.exited) {
      throw new Error("Cannot write to exited child.");
    }
    await this.#session.write(JSON.stringify(message) + "\n");
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

      // Drain injected events that arrived while awaiting
      while (this.#injectedEvents.length > 0) {
        yield this.#injectedEvents.shift()!;
      }

      const event = next.value;

      if (event.kind === "stdout") {
        const mapped = await this.#handleStdout(event.line, ctx);
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
      } else if (event.kind === "stderr") {
        // Stderr from Claude Code — emit as output
        const mapped = await mapClaudeFrame(
          { type: "_stderr", text: event.line },
          ctx
        );
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
    ctx: ClaudeMapperContext
  ): Promise<AgentSessionStreamEvent[]> {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }

    // Check if this is a permission request and capture it
    const classification = classifyClaudeFrame(frame);
    if (classification === "permission_request") {
      this.#capturePermissionRequest(frame);
    }

    return await mapClaudeFrame(frame, ctx);
  }

  #capturePermissionRequest(frame: Record<string, unknown>): void {
    const parsed = ClaudePermissionRequestSchema.safeParse(frame);
    if (!parsed.success) return;

    const perm = parsed.data;
    const toolUseId = perm.params.arguments.tool_use_id;
    const toolName = perm.params.arguments.tool_name;

    this.#pendingPermissionRpcId = perm.id;
    this.#pendingPermission = {
      schemaVersion: 1 as const,
      sessionId: this.#sessionId!,
      permissionRef: toolUseId,
      summary: `Permission required: ${toolName} (${toolUseId})`,
      evidenceDigest: "0".repeat(64),
      options: [
        { optionId: "allow", kind: "allow_once" as const, label: "Allow" },
        { optionId: "deny", kind: "deny_once" as const, label: "Deny" }
      ],
      requestedAt: new Date().toISOString()
    } as AgentPermissionRequest;
  }

  async *#handleExit(
    event: { readonly code: number | null; readonly signal: string | null },
    ctx: ClaudeMapperContext
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

    // Normal exit (code 0) after the mapper already handled any result frame
    // with is_error: true as "failed". A code-0 exit with evidence is "completed".
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

    const classified = classifyClaudeFailure({
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
        reason: `Claude process terminated (signal=${event.signal ?? "unknown"}, code=${event.code ?? "unknown"}).`,
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
      message: `Claude process exited (code=${event.code ?? "unknown"}, signal=${event.signal ?? "unknown"}).`,
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
   * pending permission. The mapper records evidence and generates the real digest;
   * the capture sets a placeholder. This keeps them consistent so
   * admitAgentPermissionResponse's digest check passes.
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
