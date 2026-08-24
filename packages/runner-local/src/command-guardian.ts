import { acquireCommandGuardianLease, type CommandGuardianLease } from "./data-root-lock.js";
import type { BoundProcessTreeAuthority, Disposable, PtyExit, PtySession } from "./pty.js";
import { MAXIMUM_GUARDIAN_INPUT_BYTES } from "./pty.js";
import type { DurableRunnerFrame } from "./replay-spool.js";
import { RedactedTranscript } from "./redacted-transcript.js";
import {
  GUARDIAN_OBSERVER_TIMEOUT_MS,
  settleBounded,
  snapshotBytes
} from "./command-guardian-bounds.js";
import { performGuardianCancellation } from "./command-guardian-cancellation.js";
import { completeGuardianCommand } from "./command-guardian-completion.js";
import { disposeGuardianExitIngress, GuardianExitAuthority } from "./command-guardian-exit.js";
import {
  EVENT_WRAPPER_RESERVE_BYTES,
  MAXIMUM_QUEUED_RAW_BYTES,
  MAXIMUM_QUEUED_RAW_FRAMES,
  TERMINAL_REPLAY_RESERVE_BYTES,
  appendTranscriptSegments,
  splitEventText
} from "./command-guardian-output.js";
import { GuardianTerminalCauseArbiter } from "./command-guardian-finalization.js";
import {
  disposeGuardianTransientResources,
  GuardianCancellationGrace,
  GuardianProcessOperationQueue,
  retainCleanupSupervisor,
  terminateProcessTree,
  type RetainedCleanupSupervisor
} from "./command-guardian-process.js";
import { GuardianDurableRecorder } from "./command-guardian-recorder.js";
import {
  authorizeAndSpawnGuardian,
  recordGuardianRunning,
  recordRejectedSpawn
} from "./command-guardian-spawn.js";
import {
  GuardianSupervisionError,
  type CommandGuardianLaunchOptions,
  type GuardianCloseOutcome,
  type GuardianHostControl,
  type GuardianHostSession,
  type GuardianTerminalEvidence
} from "./command-guardian-types.js";

export type * from "./command-guardian-types.js";

const quarantinedGuardians = new Set<GuardianRuntime>();
export const GUARDIAN_INTERNAL_PROTOCOL_FAILURE = Symbol("guardian.protocol_failure");

export class GuardianRuntime implements GuardianHostSession {
  readonly sessionId: string;
  readonly closed: Promise<GuardianCloseOutcome>;
  readonly #options: CommandGuardianLaunchOptions;
  readonly #transcript: RedactedTranscript;
  readonly #recorder: GuardianDurableRecorder;
  readonly #closedResolve: (outcome: GuardianCloseOutcome) => void;
  readonly #closedReject: (error: GuardianSupervisionError) => void;
  readonly #startMs: number;
  #lease: CommandGuardianLease | undefined;
  #pty: PtySession | undefined;
  #processTree: BoundProcessTreeAuthority | undefined;
  #disposables: Disposable[] = [];
  #exitIngress: Disposable | undefined;
  #outputTail: Promise<void> = Promise.resolve();
  #timeout: ReturnType<typeof setTimeout> | undefined;
  #eofTimer: ReturnType<typeof setTimeout> | undefined;
  #terminalPromise: Promise<void> | undefined;
  #cancelPromise: Promise<void> | undefined;
  #interruptPromise: Promise<void> | undefined;
  #protocolFailurePromise: Promise<void> | undefined;
  readonly #processOperations = new GuardianProcessOperationQueue();
  readonly #cancellationGrace = new GuardianCancellationGrace();
  #terminalFrame: DurableRunnerFrame | undefined;
  #leaseReleasePermitted = false;
  #acceptingOutput = true;
  #transcriptFailed = false;
  #ptyEofObserved = false;
  #emittedOutputBytes = 0;
  #pendingReplayText = "";
  #closedSettled = false;
  #stickyUnsafe = false;
  #hostSessionAvailable = false;
  #queuedRawBytes = 0;
  #queuedRawFrames = 0;
  #runningReady: Promise<void>;
  #runningReadyResolve: () => void;
  #runningFailed = false;
  #unsafeSupervisor: RetainedCleanupSupervisor | undefined;
  #unsafeHeartbeat: ReturnType<typeof setInterval> | undefined;
  readonly #terminalCauses = new GuardianTerminalCauseArbiter();
  readonly #exitAuthority = new GuardianExitAuthority();
  #spawnAttemptStarted = false;
  #spawnRejected = false;

  constructor(options: CommandGuardianLaunchOptions) {
    this.#options = options;
    this.sessionId = `guardian:${options.spool.intent.commandId}`;
    this.#startMs = options.monotonicNowMs();
    this.#recorder = new GuardianDurableRecorder(options.spool, options.observer, options.now);
    const outputLimit = Math.min(
      options.spool.intent.limits.eventBytes * 8,
      options.spool.intent.limits.replayBytes
    );
    this.#transcript = new RedactedTranscript({
      durableByteLimit: options.spool.intent.limits.transcriptBytes,
      liveByteLimit: outputLimit,
      replayByteLimit: outputLimit,
      sensitiveValues: options.sensitiveValues
    });
    let resolveClosed!: (outcome: GuardianCloseOutcome) => void;
    let rejectClosed!: (error: GuardianSupervisionError) => void;
    this.closed = new Promise((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    this.#closedResolve = resolveClosed;
    this.#closedReject = rejectClosed;
    let resolveRunning!: () => void;
    this.#runningReady = new Promise<void>((resolve) => {
      resolveRunning = resolve;
    });
    this.#runningReadyResolve = resolveRunning;
  }
  async start(): Promise<void> {
    try {
      this.#lease =
        this.#options.acquiredLease ??
        (await acquireCommandGuardianLease(
          this.#options.dataRoot,
          this.#options.spool.intent.commandId
        ));
      let spawn;
      try {
        spawn = await authorizeAndSpawnGuardian(this.#options, this.#recorder, () => {
          this.#spawnAttemptStarted = true;
        });
      } catch {
        if (this.#spawnAttemptStarted) {
          this.#retainUnsafe();
          throw new GuardianSupervisionError("unsafe_state");
        }
        throw new GuardianSupervisionError("maintenance_required");
      }
      if (spawn.result.status === "uncertain") {
        this.#processTree = spawn.result.processTree;
        this.#retainUnsafe();
        this.#runningFailed = true;
        this.#runningReadyResolve();
        return;
      }
      if (spawn.result.status === "rejected") {
        this.#spawnRejected = true;
        await recordRejectedSpawn(this.#options, this.#recorder, spawn.capture);
        this.#runningReadyResolve();
        this.#hostSessionAvailable = true;
        await this.#beginTerminal({
          cause: "protocol_failure",
          exit: Object.freeze({ exitCode: 1, signal: null }),
          processTreeTerminated: true,
          ptyEofObserved: false
        });
        return;
      }
      this.#pty = spawn.result.session;
      this.#processTree = spawn.result.processTree;
      this.#exitIngress = spawn.result.capture;
      this.#disposables.push(spawn.result.capture);
      const captured = spawn.capture.activate(
        Object.freeze({
          onData: (chunk: Uint8Array) => this.#queueOutput(chunk),
          onEof: () => {
            this.#acceptingOutput = false;
            this.#ptyEofObserved = true;
            this.#armEofTimer();
          },
          onExit: (exit: PtyExit) => this.#captureExit(exit)
        })
      );
      this.#ptyEofObserved = captured.eofObserved;
      for (const chunk of captured.chunks) this.#queueOutput(chunk);
      this.#exitAuthority.initialize(captured.exit, captured.exitConflict);
      this.#timeout = setTimeout(() => {
        void this.#cancel("timeout").catch(() => this.#retainUnsafe());
      }, this.#options.timeoutMs);
      if (this.#ptyEofObserved) this.#armEofTimer();
      await recordGuardianRunning(
        this.#options,
        this.#recorder,
        this.#exitAuthority.observed !== undefined
      );
      this.#runningReadyResolve();
      this.#hostSessionAvailable = true;
      if (captured.failure === "output_quarantined") {
        await this.#quarantineOutput();
      } else if (captured.failure === "protocol_failure") {
        await this.#terminateProtocolFailure();
      } else if (captured.exit !== undefined && this.#claimCause("natural")) {
        await this.#beginTerminal({
          cause: "natural",
          exit: captured.exit,
          processTreeTerminated: false,
          ptyEofObserved: captured.eofObserved
        });
      }
    } catch {
      this.#runningFailed = true;
      this.#runningReadyResolve();
      if (this.#stickyUnsafe) throw new GuardianSupervisionError("unsafe_state");
      if (this.#spawnRejected) {
        this.#cleanupAfterProvenFailure();
        throw new GuardianSupervisionError("maintenance_required");
      }
      if (!this.#spawnAttemptStarted) {
        this.#cleanupAfterProvenFailure();
        throw new GuardianSupervisionError("maintenance_required");
      }
      this.#acceptingOutput = false;
      this.#disposeTransientResources();
      const cleanup = await this.#processOperations.run(
        async () =>
          await terminateProcessTree(this.#processTree, "SIGTERM", this.#options.sensitiveValues)
      );
      if (!cleanup.terminated) this.#retainUnsafe(cleanup.retryAfter);
      else this.#cleanupAfterProvenFailure();
      throw new GuardianSupervisionError(
        cleanup.terminated ? "maintenance_required" : "unsafe_state"
      );
    }
  }
  async send(message: GuardianHostControl): Promise<void> {
    if (this.#terminalPromise !== undefined) return;
    if (message.type === "host.input") {
      if (
        typeof message.value !== "string" ||
        Buffer.byteLength(message.value) > MAXIMUM_GUARDIAN_INPUT_BYTES
      ) {
        throw new TypeError("Guardian input is invalid.");
      }
      this.#pty?.write(message.value);
      return;
    }
    if (message.type === "host.resize") {
      if (
        !Number.isInteger(message.columns) ||
        message.columns < 20 ||
        message.columns > 500 ||
        !Number.isInteger(message.rows) ||
        message.rows < 5 ||
        message.rows > 300
      ) {
        throw new TypeError("Guardian resize is invalid.");
      }
      this.#pty?.resize(message.columns, message.rows);
      return;
    }
    if (message.type === "host.cancel") {
      await this.#cancel(message);
      return;
    }
    if (message.type === "host.interrupt") {
      await this.#interrupt();
      return;
    }
    if (message.type === "host.protocol_failure") {
      if (message.reason !== "output_quarantined") {
        throw new TypeError("Guardian protocol failure is invalid.");
      }
      await this.#quarantineOutput();
      return;
    }
    throw new TypeError("Guardian control is invalid.");
  }
  async disconnect(): Promise<void> {
    await this.#interrupt();
    try {
      await settleBounded(this.#options.observer.onDisconnect?.(), GUARDIAN_OBSERVER_TIMEOUT_MS);
    } catch {
      // Durable interruption does not depend on a disconnected observer.
    }
  }
  async [GUARDIAN_INTERNAL_PROTOCOL_FAILURE](): Promise<void> {
    await this.#terminateProtocolFailure();
  }
  async #acceptOutput(chunk: Uint8Array): Promise<void> {
    let result;
    try {
      result = this.#transcript.write(chunk);
    } catch {
      this.#transcriptFailed = true;
      this.#acceptingOutput = false;
      void this.#quarantineOutput().catch(() => this.#retainUnsafe());
      return;
    }
    if (result.durable.byteLength > 0) {
      await appendTranscriptSegments(this.#options.spool, result.durable);
    }
    for (const output of result.replayOutput) {
      await this.#acceptReplayText(output, false);
    }
  }
  #queueOutput(chunk: Uint8Array): void {
    if (!this.#acceptingOutput) return;
    let immutable: Uint8Array;
    try {
      immutable = snapshotBytes(chunk, { maximumBytes: MAXIMUM_QUEUED_RAW_BYTES });
    } catch {
      this.#acceptingOutput = false;
      void this.#quarantineOutput().catch(() => this.#retainUnsafe());
      return;
    }
    const byteLength = immutable.byteLength;
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      this.#queuedRawFrames >= MAXIMUM_QUEUED_RAW_FRAMES ||
      this.#queuedRawBytes + byteLength > MAXIMUM_QUEUED_RAW_BYTES
    ) {
      this.#acceptingOutput = false;
      void this.#quarantineOutput().catch(() => this.#retainUnsafe());
      return;
    }
    this.#queuedRawBytes += byteLength;
    this.#queuedRawFrames += 1;
    const accepted = this.#outputTail.then(async () => {
      await this.#runningReady;
      if (!this.#runningFailed) await this.#acceptOutput(immutable);
    });
    this.#outputTail = accepted
      .catch(() => {
        this.#transcriptFailed = true;
        this.#acceptingOutput = false;
        void this.#quarantineOutput().catch(() => this.#retainUnsafe());
      })
      .finally(() => {
        this.#queuedRawBytes -= byteLength;
        this.#queuedRawFrames -= 1;
      });
  }
  async #acceptReplayText(output: string, flush: boolean): Promise<void> {
    const maximumTextBytes = Math.max(
      1,
      Math.min(65_536, this.#options.spool.intent.limits.eventBytes) - EVENT_WRAPPER_RESERVE_BYTES
    );
    let chunks = splitEventText(this.#pendingReplayText + output, maximumTextBytes);
    this.#pendingReplayText = "";
    if (!flush && chunks.length > 0) {
      this.#pendingReplayText = chunks.at(-1)!;
      chunks = chunks.slice(0, -1);
    }
    for (const text of chunks) {
      this.#emittedOutputBytes += Buffer.byteLength(text);
      await this.#recorder.appendEvent(
        { type: "terminal.output", stream: "pty", text },
        TERMINAL_REPLAY_RESERVE_BYTES
      );
    }
  }
  #armEofTimer(): void {
    if (this.#eofTimer !== undefined || this.#terminalPromise !== undefined) return;
    this.#eofTimer = setTimeout(() => {
      void this.#interrupt().catch(() => this.#retainUnsafe());
    }, this.#options.eofSettleMs);
  }
  #claimCause(cause: GuardianTerminalEvidence["cause"]): boolean {
    const claimed = this.#terminalCauses.claim(cause, this.#terminalPromise !== undefined);
    if (claimed) this.#acceptingOutput = false;
    return claimed;
  }
  #captureExit(exit: GuardianTerminalEvidence["exit"]): void {
    let observed;
    try {
      observed = this.#exitAuthority.observe(exit, this.#options.sensitiveValues);
    } catch {
      void this.#terminateProtocolFailure().catch(() => this.#retainUnsafe());
      return;
    }
    if (observed.ignored) return;
    if (observed.conflict) {
      void this.#terminateProtocolFailure().catch(() => this.#retainUnsafe());
      return;
    }
    if (!observed.first) return;
    this.#cancellationGrace.release();
    if (!this.#claimCause("natural")) return;
    void this.#beginTerminal({
      cause: "natural",
      exit: observed.exit!,
      processTreeTerminated: false,
      ptyEofObserved: this.#ptyEofObserved
    }).catch(() => this.#retainUnsafe());
  }
  async #cancel(
    control: Extract<GuardianHostControl, { readonly type: "host.cancel" }> | "timeout"
  ): Promise<void> {
    const cause = control === "timeout" ? "timeout" : "cancelled";
    if (!this.#claimCause(cause)) {
      if (this.#terminalPromise !== undefined) return await this.#terminalPromise;
      return;
    }
    if (this.#terminalPromise !== undefined) return await this.#terminalPromise;
    if (this.#cancelPromise !== undefined) return await this.#cancelPromise;
    this.#cancelPromise = this.#processOperations.run(
      async () => await this.#performCancel(control)
    );
    await this.#cancelPromise;
  }
  async #performCancel(
    control: Extract<GuardianHostControl, { readonly type: "host.cancel" }> | "timeout"
  ): Promise<void> {
    const authority = this.#processTree;
    if (authority === undefined) return;
    await performGuardianCancellation({
      control,
      authority,
      spool: this.#options.spool,
      recorder: this.#recorder,
      observer: this.#options.observer,
      cancellationGrace: this.#cancellationGrace,
      cancellationGraceMs: this.#options.cancellationGraceMs,
      sensitiveValues: this.#options.sensitiveValues,
      winningCause: () => this.#terminalCauses.winning,
      retainUnsafe: (retryAfter) => this.#retainUnsafe(retryAfter),
      cleanupAfterProvenFailure: () => this.#cleanupAfterProvenFailure(),
      admitAuthoritativeProof: (proof) => this.#sealAuthoritativeProof(proof),
      beginTerminal: async (evidence) => await this.#beginTerminal(evidence),
      ptyEofObserved: () => this.#ptyEofObserved
    });
  }
  async #interrupt(): Promise<void> {
    if (!this.#claimCause("interrupted")) {
      if (this.#terminalPromise !== undefined) return await this.#terminalPromise;
      return;
    }
    this.#interruptPromise ??= this.#processOperations.run(async () => {
      await this.#performInterrupt();
    });
    await this.#interruptPromise;
  }
  async #performInterrupt(): Promise<void> {
    const cleanup = await terminateProcessTree(
      this.#processTree,
      "SIGTERM",
      this.#options.sensitiveValues
    );
    if (!cleanup.terminated) {
      this.#retainUnsafe(cleanup.retryAfter);
      return;
    }
    const exit = this.#sealAuthoritativeProof(cleanup.proof);
    if (exit === undefined) {
      this.#retainUnsafe();
      return;
    }
    await this.#beginTerminal({
      cause: "interrupted",
      exit,
      processTreeTerminated: true,
      ptyEofObserved: this.#ptyEofObserved
    });
  }
  async #terminateProtocolFailure(): Promise<void> {
    if (!this.#claimCause("protocol_failure")) {
      if (this.#terminalPromise !== undefined) return await this.#terminalPromise;
      return;
    }
    this.#protocolFailurePromise ??= this.#processOperations.run(async () => {
      await this.#performProtocolFailure();
    });
    await this.#protocolFailurePromise;
  }

  async #performProtocolFailure(): Promise<void> {
    const cleanup = await terminateProcessTree(
      this.#processTree,
      "SIGTERM",
      this.#options.sensitiveValues
    );
    if (!cleanup.terminated) {
      this.#retainUnsafe(cleanup.retryAfter);
      return;
    }
    const exit =
      this.#processTree === undefined
        ? Object.freeze({ exitCode: 1, signal: null })
        : this.#sealAuthoritativeProof(cleanup.proof);
    if (exit === undefined) {
      this.#retainUnsafe();
      return;
    }
    await this.#beginTerminal({
      cause: "protocol_failure",
      exit,
      processTreeTerminated: true,
      ptyEofObserved: this.#ptyEofObserved
    });
  }
  async #quarantineOutput(): Promise<void> {
    if (!this.#claimCause("output_quarantined")) {
      if (this.#terminalPromise !== undefined) return await this.#terminalPromise;
      return;
    }
    if (this.#terminalPromise !== undefined) return await this.#terminalPromise;
    this.#terminalPromise = this.#processOperations.run(
      async () => await this.#terminateQuarantinedOutput()
    );
    await this.#terminalPromise;
  }

  async #terminateQuarantinedOutput(): Promise<void> {
    const cleanup = await terminateProcessTree(
      this.#processTree,
      "SIGTERM",
      this.#options.sensitiveValues
    );
    const exit = this.#sealAuthoritativeProof(cleanup.proof);
    if (!cleanup.terminated || exit === undefined) {
      this.#retainUnsafe(cleanup.retryAfter);
      return;
    }
    await this.#finalize({
      cause: "output_quarantined",
      exit,
      processTreeTerminated: true,
      ptyEofObserved: this.#ptyEofObserved
    });
  }
  async #beginTerminal(evidence: GuardianTerminalEvidence): Promise<void> {
    if (!this.#claimCause(evidence.cause)) return;
    if (this.#terminalPromise !== undefined) return await this.#terminalPromise;
    this.#terminalPromise = this.#finalize(evidence);
    await this.#terminalPromise;
  }

  async #finalize(initial: GuardianTerminalEvidence): Promise<void> {
    let evidence = initial;
    try {
      await this.#runningReady;
      if (this.#runningFailed) throw new TypeError();
      if (this.#timeout !== undefined) clearTimeout(this.#timeout);
      if (this.#eofTimer !== undefined) clearTimeout(this.#eofTimer);
      await this.#outputTail;
      const durationMs = Math.max(0, Math.floor(this.#options.monotonicNowMs() - this.#startMs));
      const completion = await completeGuardianCommand({
        artifactStore: this.#options.artifactStore,
        spool: this.#options.spool,
        recorder: this.#recorder,
        transcript: this.#transcript,
        transcriptFailed: this.#transcriptFailed,
        ...(this.#processTree === undefined ? {} : { processTree: this.#processTree }),
        ...(this.#exitAuthority.observed === undefined
          ? {}
          : { observedExit: this.#exitAuthority.observed }),
        observedExitConflict: this.#exitAuthority.conflict,
        sensitiveValues: this.#options.sensitiveValues,
        initialEvidence: evidence,
        readEmittedOutputBytes: () => this.#emittedOutputBytes,
        durationMs,
        acceptReplayText: async (output, flush) => await this.#acceptReplayText(output, flush),
        admitAuthoritativeProof: (proof) => this.#sealAuthoritativeProof(proof) !== undefined,
        assertAuthoritativeProof: () => {
          if (
            this.#processTree !== undefined &&
            (!this.#exitAuthority.proofIsCurrent || this.#exitIngress !== undefined)
          ) {
            throw new TypeError();
          }
        }
      });
      if (completion.status === "unsafe") {
        this.#retainUnsafe(completion.retryAfter);
        return;
      }
      this.#terminalFrame = completion.frame;
      this.#leaseReleasePermitted = true;
    } catch {
      if (this.#exitAuthority.conflict) {
        this.#retainUnsafe();
        return;
      }
      const cleanup = await terminateProcessTree(
        this.#processTree,
        "SIGTERM",
        this.#options.sensitiveValues
      );
      if (!cleanup.terminated || this.#sealAuthoritativeProof(cleanup.proof) === undefined) {
        this.#retainUnsafe(cleanup.retryAfter);
        return;
      }
      this.#cleanupAfterProvenFailure();
      return;
    }
    this.#cleanup();
  }
  #sealAuthoritativeProof(
    proof: Parameters<GuardianExitAuthority["sealProof"]>[0]
  ): GuardianTerminalEvidence["exit"] | undefined {
    const wasSealed = this.#exitAuthority.sealed;
    const exit = this.#exitAuthority.sealProof(proof);
    if (exit === undefined || wasSealed) return exit;
    const ingress = this.#exitIngress;
    if (ingress === undefined) return undefined;
    this.#exitIngress = undefined;
    return disposeGuardianExitIngress(ingress, this.#disposables) ? exit : undefined;
  }
  #disposeTransientResources(): void {
    this.#exitIngress = undefined;
    disposeGuardianTransientResources({
      timers: [this.#timeout, this.#eofTimer],
      disposables: this.#disposables.splice(0)
    });
    this.#cancellationGrace.dispose();
  }

  #retainUnsafe(retryAfter?: Promise<void>): void {
    if (retryAfter !== undefined) this.#processOperations.blockUntil(retryAfter);
    if (this.#stickyUnsafe) return;
    this.#stickyUnsafe = true;
    this.#acceptingOutput = false;
    this.#disposeTransientResources();
    quarantinedGuardians.add(this);
    if (
      this.#processTree !== undefined &&
      !this.#exitAuthority.conflict &&
      this.#unsafeSupervisor === undefined
    ) {
      this.#unsafeSupervisor = retainCleanupSupervisor(
        this.#processTree,
        () => {
          this.#disposeTransientResources();
          try {
            this.#lease?.close();
          } finally {
            this.#lease = undefined;
            this.#pty = undefined;
            this.#processTree = undefined;
            quarantinedGuardians.delete(this);
          }
        },
        this.#processOperations,
        this.#options.sensitiveValues,
        retryAfter
      );
      void this.#unsafeSupervisor.closed.catch(() => undefined);
    } else if (
      (this.#processTree === undefined || this.#exitAuthority.conflict) &&
      this.#unsafeHeartbeat === undefined
    ) {
      this.#unsafeHeartbeat = setInterval(() => undefined, 1_000);
      this.#unsafeHeartbeat.ref();
    }
    if (!this.#closedSettled) {
      this.#closedSettled = true;
      this.#closedReject(new GuardianSupervisionError("unsafe_state"));
    }
  }

  #cleanupAfterProvenFailure(): void {
    this.#disposeTransientResources();
    try {
      this.#lease?.close();
    } finally {
      this.#lease = undefined;
      this.#pty = undefined;
      this.#processTree = undefined;
    }
    if (this.#hostSessionAvailable && !this.#closedSettled) {
      this.#closedSettled = true;
      this.#closedReject(new GuardianSupervisionError("maintenance_required"));
    }
  }

  #cleanup(): void {
    this.#disposeTransientResources();
    let releasedLease = false;
    try {
      if (this.#leaseReleasePermitted) {
        this.#lease?.close();
        releasedLease = this.#lease !== undefined;
      }
    } catch {
      releasedLease = false;
    }
    this.#lease = undefined;
    this.#pty = undefined;
    this.#processTree = undefined;
    if (this.#closedSettled) return;
    this.#closedSettled = true;
    this.#closedResolve(
      Object.freeze({
        commandId: this.#options.spool.intent.commandId,
        ...(this.#terminalFrame === undefined ? {} : { terminalFrame: this.#terminalFrame }),
        releasedLease
      })
    );
  }
}

export { CommandGuardian } from "./command-guardian-launch.js";
