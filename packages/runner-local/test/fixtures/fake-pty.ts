import type { ArtifactStore } from "../../src/artifact-store.js";
import type { GuardianBootstrap, GuardianLauncher } from "../../src/command-executor-types.js";
import type {
  GuardianHostControl,
  GuardianHostObserver,
  GuardianHostSession
} from "../../src/command-guardian.js";
import {
  CommandGuardianHostProtocolAdapter,
  type GuardianToHostPayload,
  type HostToGuardianPayload
} from "../../src/command-guardian-protocol.js";
import { CommandGuardianProtocolRuntime } from "../../src/command-guardian-child-runtime.js";
import type {
  AtomicPtySpawnAuthority,
  BoundProcessTreeAuthority,
  Disposable,
  GuardianAuthenticatedEnvelope,
  PtyExit,
  PtyCapture,
  PtySession,
  PtySpawnRequest,
  BoundPtySpawnResult
} from "../../src/pty.js";
import { sealGuardianEnvelope } from "../../src/pty.js";
import { ReplaySpool, type DurableRunnerFrame } from "../../src/replay-spool.js";

interface FakeAuthenticatedGuardianLauncherOptions {
  readonly artifactStore: ArtifactStore;
  readonly spawnAuthority: AtomicPtySpawnAuthority;
  readonly now: () => string;
  readonly monotonicNowMs: () => number;
  readonly hostEnqueueDelayMs?: number;
  readonly onGuardianPayload?: (payload: GuardianToHostPayload) => void;
  readonly acknowledgeFramesReentrantly?: boolean;
}

export class FakePtySession implements PtySession {
  processGroupIds = [41001];
  processGroupReadCount = 0;
  readonly writes: string[] = [];
  readonly resizes: Array<Readonly<{ columns: number; rows: number }>> = [];
  readonly #dataListeners = new Set<(chunk: Uint8Array) => void>();
  readonly #eofListeners = new Set<() => void>();
  readonly #exitListeners = new Set<(exit: PtyExit) => void>();
  #exited = false;
  listenerFailure: Error | undefined;
  eofListenerFailure: Error | undefined;

  onData(listener: (chunk: Uint8Array) => void): Disposable {
    if (this.listenerFailure !== undefined) throw this.listenerFailure;
    this.#dataListeners.add(listener);
    return { dispose: () => this.#dataListeners.delete(listener) };
  }

  onEof(listener: () => void): Disposable {
    if (this.eofListenerFailure !== undefined) throw this.eofListenerFailure;
    this.#eofListeners.add(listener);
    return { dispose: () => this.#eofListeners.delete(listener) };
  }

  onExit(listener: (exit: PtyExit) => void): Disposable {
    this.#exitListeners.add(listener);
    return { dispose: () => this.#exitListeners.delete(listener) };
  }

  installCapture(capture: PtyCapture): Disposable {
    const disposables: Disposable[] = [];
    try {
      disposables.push(this.onData(capture.onData));
      disposables.push(this.onEof(capture.onEof));
      disposables.push(this.onExit(capture.onExit));
      return Object.freeze({
        dispose: () => {
          for (const disposable of disposables) disposable.dispose();
        }
      });
    } catch (error) {
      for (const disposable of disposables) disposable.dispose();
      throw error;
    }
  }

  write(value: string): void {
    if (!this.#exited) this.writes.push(value);
  }

  resize(columns: number, rows: number): void {
    if (!this.#exited) this.resizes.push(Object.freeze({ columns, rows }));
  }

  emitData(chunk: Uint8Array): void {
    for (const listener of [...this.#dataListeners]) listener(Uint8Array.from(chunk));
  }

  emitRawForTesting(chunk: Uint8Array): void {
    for (const listener of [...this.#dataListeners]) listener(chunk);
  }

  emitEof(): void {
    for (const listener of [...this.#eofListeners]) listener();
  }

  emitExit(exit: PtyExit): void {
    if (this.#exited) return;
    this.#exited = true;
    for (const listener of [...this.#exitListeners]) listener(Object.freeze({ ...exit }));
  }

  emitRawExitForTesting(exit: PtyExit): void {
    if (this.#exited) return;
    this.#exited = true;
    for (const listener of [...this.#exitListeners]) listener(exit);
  }

  replayExitForTesting(exit: PtyExit): void {
    for (const listener of [...this.#exitListeners]) listener(Object.freeze({ ...exit }));
  }

  get listenerCount(): number {
    return this.#dataListeners.size + this.#eofListeners.size + this.#exitListeners.size;
  }

  get liveProcessGroupId(): number {
    const index = Math.min(this.processGroupReadCount++, this.processGroupIds.length - 1);
    return this.processGroupIds[index]!;
  }
}

export class FakePtyFactory implements AtomicPtySpawnAuthority {
  readonly session = new FakePtySession();
  readonly spawnRequests: PtySpawnRequest[] = [];
  spawnFailure: Error | undefined;
  createThenThrow = false;
  actualExecutableIdentityDigest: string | undefined;
  actualCwdIdentityDigest: string | undefined;
  retainedUncertain = false;
  uncertainDescendantsAbsent = false;
  afterSpawn: ((session: FakePtySession) => void) | undefined;
  identityDecision: boolean | (() => boolean) = true;
  processTreeAuthority: BoundProcessTreeAuthority | undefined;

  readonly #uncertainAuthority: BoundProcessTreeAuthority = Object.freeze({
    identityDigest: "f".repeat(64),
    signal: async (_signal: "SIGINT" | "SIGTERM" | "SIGKILL", abortSignal: AbortSignal) => {
      if (abortSignal.aborted) throw new TypeError("aborted");
    },
    waitForExit: async (abortSignal: AbortSignal) => {
      if (abortSignal.aborted) throw new TypeError("aborted");
      return this.uncertainDescendantsAbsent
        ? Object.freeze({
            identityDigest: this.#uncertainAuthority.identityDigest,
            processTreeTerminated: true as const,
            exit: Object.freeze({ exitCode: 0, signal: null })
          })
        : Object.freeze({
            identityDigest: this.#uncertainAuthority.identityDigest,
            processTreeTerminated: false as const,
            exit: null
          });
    }
  });

  spawnBound(
    input: Readonly<{
      request: PtySpawnRequest;
      expectedExecutableIdentityDigest: string;
      expectedCwdIdentityDigest: string;
      privateEnvironment: Readonly<{ home: string; temporary: string }>;
      capture: PtyCapture;
    }>
  ): BoundPtySpawnResult {
    if (this.spawnFailure !== undefined) throw this.spawnFailure;
    const valid =
      (typeof this.identityDecision === "function"
        ? this.identityDecision()
        : this.identityDecision) &&
      (this.actualExecutableIdentityDigest ?? input.expectedExecutableIdentityDigest) ===
        input.expectedExecutableIdentityDigest &&
      (this.actualCwdIdentityDigest ?? input.expectedCwdIdentityDigest) ===
        input.expectedCwdIdentityDigest;
    if (!valid) return Object.freeze({ status: "rejected" });
    const capture = this.session.installCapture(input.capture);
    const request = input.request;
    this.spawnRequests.push(
      Object.freeze({
        ...request,
        args: Object.freeze([...request.args]),
        environment: Object.freeze(request.environment.map((entry) => Object.freeze({ ...entry }))),
        terminal: Object.freeze({ ...request.terminal })
      })
    );
    if (this.createThenThrow) {
      this.retainedUncertain = true;
      capture.dispose();
      return Object.freeze({ status: "uncertain", processTree: this.#uncertainAuthority });
    }
    this.afterSpawn?.(this.session);
    const processTree = this.processTreeAuthority;
    if (processTree === undefined) throw new TypeError("Fake process authority is unavailable.");
    return Object.freeze({ status: "spawned", session: this.session, processTree, capture });
  }
}

export class FakeProcessTreeController implements BoundProcessTreeAuthority {
  readonly identityDigest = "a".repeat(64);
  readonly calls: Array<Readonly<{ signal?: string; type: string }>> = [];
  gracefulExit = true;
  terminated = true;
  signalFailure: Error | undefined;
  waitFailure: Error | undefined;
  onSignal: ((signal: "SIGINT" | "SIGTERM" | "SIGKILL") => void) | undefined;
  actualExit: PtyExit | undefined;

  async signal(signal: "SIGINT" | "SIGTERM" | "SIGKILL", abortSignal: AbortSignal): Promise<void> {
    if (abortSignal.aborted) throw new TypeError("aborted");
    if (this.signalFailure !== undefined) throw this.signalFailure;
    this.calls.push(Object.freeze({ type: "signal", signal }));
    this.onSignal?.(signal);
  }

  async waitForExit(abortSignal: AbortSignal) {
    if (abortSignal.aborted) throw new TypeError("aborted");
    if (this.waitFailure !== undefined) throw this.waitFailure;
    this.calls.push(Object.freeze({ type: "wait" }));
    const terminated = this.calls.some((call) => call.signal === "SIGKILL")
      ? this.terminated
      : this.gracefulExit;
    if (!terminated) {
      return Object.freeze({
        identityDigest: this.identityDigest,
        processTreeTerminated: false as const,
        exit: null
      });
    }
    const requested = this.calls.findLast((call) => call.signal !== undefined)?.signal ?? null;
    return Object.freeze({
      identityDigest: this.identityDigest,
      processTreeTerminated: true as const,
      exit: Object.freeze(
        this.actualExit ?? {
          exitCode: requested === null ? 0 : null,
          signal: requested
        }
      )
    });
  }
}

export class FakeAuthenticatedGuardianLauncher implements GuardianLauncher {
  readonly protocolTrace: string[] = [];
  readonly #options: FakeAuthenticatedGuardianLauncherOptions;
  #runtime: CommandGuardianProtocolRuntime | undefined;
  #hostAdapter: CommandGuardianHostProtocolAdapter | undefined;
  #bootstrap: GuardianBootstrap | undefined;
  #hostSequence = 0;

  constructor(options: FakeAuthenticatedGuardianLauncherOptions) {
    this.#options = options;
  }

  async launch(
    bootstrap: GuardianBootstrap,
    observer: GuardianHostObserver
  ): Promise<GuardianHostSession> {
    if (this.#runtime !== undefined) throw new TypeError("Fake guardian launcher is single-use.");
    this.#bootstrap = bootstrap;
    const spool = await ReplaySpool.open({
      dataRoot: bootstrap.dataRoot,
      commandId: bootstrap.commandId
    });
    if (
      bootstrap.intentRelativePath !==
      `commands/${Buffer.from(bootstrap.commandId).toString("hex")}/receipt/01-intent.json`
    ) {
      throw new TypeError("Fake guardian intent path is invalid.");
    }
    let childRuntime: CommandGuardianProtocolRuntime | undefined;
    let hostAdapter!: CommandGuardianHostProtocolAdapter;
    const acknowledgeFramesReentrantly = this.#options.acknowledgeFramesReentrantly === true;
    hostAdapter = CommandGuardianHostProtocolAdapter.create({
      bootstrap,
      observer: Object.freeze({
        ...observer,
        async onDurableFrame(frame: DurableRunnerFrame, signal?: AbortSignal) {
          await observer.onDurableFrame(frame, signal);
          if (acknowledgeFramesReentrantly) {
            await hostAdapter.acknowledgeEvent(frame.sequence);
          }
        }
      }),
      send: async (message, signal) => {
        if (childRuntime === undefined) throw new TypeError("Fake guardian is unavailable.");
        if (signal.aborted) throw new TypeError("Fake guardian send was aborted.");
        if (this.#options.hostEnqueueDelayMs === undefined) {
          await childRuntime.receive(message);
          return;
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            void childRuntime!.receive(message).then(resolve, reject);
          }, this.#options.hostEnqueueDelayMs);
          const onAbort = () => {
            clearTimeout(timer);
            reject(new TypeError("Fake guardian send was aborted."));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
      },
      disconnect: async (signal) => {
        if (signal.aborted) throw new TypeError("Fake guardian disconnect was aborted.");
        await childRuntime?.disconnect();
      }
    });
    this.#hostAdapter = hostAdapter;
    const runtime = await CommandGuardianProtocolRuntime.bootstrap({
      bootstrap,
      artifactStore: this.#options.artifactStore,
      spawnAuthority: this.#options.spawnAuthority,
      now: this.#options.now,
      monotonicNowMs: this.#options.monotonicNowMs,
      createNonce: () => Uint8Array.from({ length: 32 }, (_value, index) => index + 1),
      send: async (message, signal) => {
        if (signal.aborted) throw new TypeError("Fake guardian send was aborted.");
        this.#recordWirePayloadForTesting(message.payload);
        this.#options.onGuardianPayload?.(message.payload);
        await hostAdapter.receive(message);
      }
    });
    childRuntime = runtime;
    this.#runtime = runtime;
    void runtime.closed.catch(() => undefined);
    if (!this.protocolTrace.includes("guardian.hello"))
      throw new TypeError("Guardian hello was not authenticated.");
    this.protocolTrace.push("host.lease_transfer");
    await hostAdapter.transferLease(spool.intent.receiptDigest);
    this.#hostSequence = 1;
    return hostAdapter.session;
  }

  sealHostControlForTesting(
    control: GuardianHostControl
  ): GuardianAuthenticatedEnvelope<HostToGuardianPayload> {
    return this.#sealHost(control);
  }

  sealHostPayloadForTesting(payload: unknown): GuardianAuthenticatedEnvelope<unknown> {
    return this.#sealHost(payload);
  }

  async sendHostPayloadForTesting(payload: HostToGuardianPayload): Promise<void> {
    if (payload.type !== "host.event_ack" || this.#hostAdapter === undefined) {
      throw new TypeError("Fake guardian test payload is unavailable.");
    }
    await this.#hostAdapter.acknowledgeEvent(payload.sequence);
    this.#hostSequence += 1;
  }

  async deliverHostEnvelopeForTesting(
    envelope: GuardianAuthenticatedEnvelope<unknown>
  ): Promise<void> {
    if (this.#runtime === undefined) throw new TypeError("Fake guardian is unavailable.");
    await this.#runtime.receive(envelope);
  }

  async transportClosedForTesting(): Promise<void> {
    if (this.#hostAdapter === undefined) throw new TypeError("Fake guardian is unavailable.");
    await (this.#hostAdapter as unknown as { transportClosed(): Promise<void> }).transportClosed();
    if (this.#runtime !== undefined) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.#runtime.closed.then(
            () => undefined,
            () => undefined
          ),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new TypeError("Fake guardian cleanup timed out.")),
              2_000
            );
          })
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  }

  async waitForChildForTesting(): Promise<void> {
    if (this.#runtime === undefined) throw new TypeError("Fake guardian is unavailable.");
    await this.#runtime.closed.then(
      () => undefined,
      () => undefined
    );
  }

  childRuntimeForTesting(): CommandGuardianProtocolRuntime {
    if (this.#runtime === undefined) throw new TypeError("Fake guardian is unavailable.");
    return this.#runtime;
  }

  async #sendHost(payload: HostToGuardianPayload): Promise<void> {
    if (this.#runtime === undefined) throw new TypeError("Fake guardian is unavailable.");
    await this.#runtime.receive(this.#sealHost(payload));
  }

  #sealHost<Payload>(payload: Payload): GuardianAuthenticatedEnvelope<Payload> {
    const bootstrap = this.#bootstrap;
    if (bootstrap === undefined) throw new TypeError("Fake guardian is unavailable.");
    return sealGuardianEnvelope({
      sessionId: bootstrap.session.sessionId,
      secret: bootstrap.session.secret,
      direction: "host_to_guardian",
      sequence: ++this.#hostSequence,
      payload
    });
  }

  // Trace-only: authorization and dispatch remain exclusively in the real host adapter.
  #recordWirePayloadForTesting(payload: GuardianToHostPayload): void {
    if (payload.type === "guardian.hello") {
      this.protocolTrace.push(payload.type);
      return;
    }
    if (payload.type === "guardian.lease_acquired") {
      this.protocolTrace.push(payload.type);
      return;
    }
    if (payload.type === "guardian.phase") {
      this.protocolTrace.push(`${payload.type}:${payload.phase}`);
      return;
    }
    if (payload.type === "guardian.event_committed") {
      this.protocolTrace.push(`${payload.type}:${payload.frame.event.type}`);
      return;
    }
    if (payload.type === "guardian.cancel_ack") {
      this.protocolTrace.push(payload.type);
      return;
    }
    if (payload.type === "guardian.protocol_failure") {
      this.protocolTrace.push(payload.type);
      return;
    }
    this.protocolTrace.push(payload.type);
  }
}
