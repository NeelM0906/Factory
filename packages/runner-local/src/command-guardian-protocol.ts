import { createHash } from "node:crypto";

import {
  type GuardianCloseOutcome,
  type GuardianHostControl,
  type GuardianHostObserver,
  type GuardianHostSession
} from "./command-guardian-types.js";
import type { GuardianBootstrap } from "./command-executor-types.js";
import {
  sealGuardianEnvelope,
  verifyGuardianEnvelope,
  MAXIMUM_GUARDIAN_ENVELOPE_BYTES,
  type GuardianAuthenticatedEnvelope
} from "./pty.js";
import { ReplaySpool } from "./replay-spool.js";
import { canonicalJson, parseFrame } from "./replay-spool-codec.js";
import { snapshotGuardianBootstrap } from "./command-spawn-envelope.js";
import {
  MAXIMUM_PENDING_PROTOCOL_MESSAGES,
  GUARDIAN_OBSERVER_TIMEOUT_MS,
  captureGuardianMethod,
  snapshotDataRecord,
  snapshotSafeJson,
  runAbortableGuardianOperation,
  settleBounded
} from "./command-guardian-bounds.js";
import {
  exactProtocolKeys,
  parseHostPayload,
  type HostToGuardianPayload
} from "./command-guardian-protocol-codec.js";
import type {
  GuardianHostProtocolAdapterOptions,
  GuardianToHostPayload
} from "./command-guardian-protocol-types.js";

export type { HostToGuardianPayload } from "./command-guardian-protocol-codec.js";
export type {
  GuardianChildRuntimeOptions,
  GuardianHostProtocolAdapterOptions,
  GuardianToHostPayload
} from "./command-guardian-protocol-types.js";

/** Reviewed host-side HMAC/sequence adapter shared by desktop IPC and the fake launcher. */
export class CommandGuardianHostProtocolAdapter {
  readonly #dataRoot: string;
  readonly #commandId: GuardianBootstrap["commandId"];
  readonly #sessionId: string;
  readonly #bindingDigest: string;
  readonly #timeoutMs: number;
  #sessionSecret: Uint8Array | undefined;
  readonly #observer: GuardianHostObserver;
  readonly #sendTransport: GuardianHostProtocolAdapterOptions["send"];
  readonly #disconnectTransport: GuardianHostProtocolAdapterOptions["disconnect"];
  readonly #durableSpool: Promise<ReplaySpool>;
  readonly #closedResolve: (outcome: GuardianCloseOutcome) => void;
  readonly #closedReject: (error: TypeError) => void;
  readonly session: GuardianHostSession;
  #hostSequence = 0;
  #guardianSequence = 0;
  #helloNonce: string | undefined;
  #leaseReceiptDigest: string | undefined;
  #lastFrameDigest: string | undefined;
  #lastFrameSequence = 0;
  #lastFrameCanonical: string | undefined;
  #lastEventAck = 0;
  #lastPhaseIndex = 0;
  #protocolFailureNotified = false;
  #transferred = false;
  #state: "open" | "closing" | "settled" = "open";
  #receiveTail: Promise<void> = Promise.resolve();
  #sendInvocationTail: Promise<void> = Promise.resolve();
  #disconnectPromise: Promise<void> | undefined;
  #transportClosePromise: Promise<void> | undefined;
  #protocolTeardownPromise: Promise<void> | undefined;
  #pendingReceives = 0;
  #pendingSends = 0;
  #pendingSendBytes = 0;
  readonly #unsettledTransport = new Set<Promise<void>>();
  #transportHeartbeat: ReturnType<typeof setInterval> | undefined;
  #pendingCancel:
    | Readonly<{
        requestDigest: string;
        resolve: () => void;
        reject: (error: TypeError) => void;
        promise: Promise<void>;
      }>
    | undefined;

  private constructor(options: GuardianHostProtocolAdapterOptions, bootstrap: GuardianBootstrap) {
    this.#dataRoot = bootstrap.dataRoot;
    this.#commandId = bootstrap.commandId;
    this.#sessionId = bootstrap.session.sessionId;
    this.#bindingDigest = bootstrap.session.bindingDigest;
    this.#timeoutMs = bootstrap.timeoutMs;
    this.#sessionSecret = Uint8Array.from(bootstrap.session.secret);
    this.#observer = Object.freeze({
      onDurableFrame: options.observer.onDurableFrame,
      ...(options.observer.onDurablePhase === undefined
        ? {}
        : { onDurablePhase: options.observer.onDurablePhase }),
      ...(options.observer.onDisconnect === undefined
        ? {}
        : { onDisconnect: options.observer.onDisconnect }),
      ...(options.observer.onCancelAck === undefined
        ? {}
        : { onCancelAck: options.observer.onCancelAck })
    });
    this.#sendTransport = options.send;
    this.#disconnectTransport = options.disconnect;
    this.#durableSpool = ReplaySpool.open({
      dataRoot: this.#dataRoot,
      commandId: this.#commandId
    });
    void this.#durableSpool.catch(() => undefined);
    let resolveClosed!: (outcome: GuardianCloseOutcome) => void;
    let rejectClosed!: (error: TypeError) => void;
    const closed = new Promise<GuardianCloseOutcome>((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    void closed.catch(() => undefined);
    this.#closedResolve = resolveClosed;
    this.#closedReject = rejectClosed;
    this.session = Object.freeze({
      sessionId: bootstrap.session.sessionId,
      send: async (control: GuardianHostControl) => await this.#sendControl(control),
      disconnect: async () => await this.#disconnect(),
      closed
    });
  }

  static create(options: GuardianHostProtocolAdapterOptions): CommandGuardianHostProtocolAdapter {
    try {
      const candidate = snapshotDataRecord(options, 4);
      const observer = snapshotDataRecord(candidate.observer, 4);
      const onDurableFrame = captureGuardianMethod(observer, "onDurableFrame")!;
      const onDurablePhase = captureGuardianMethod(observer, "onDurablePhase", true);
      const onDisconnect = captureGuardianMethod(observer, "onDisconnect", true);
      const onCancelAck = captureGuardianMethod(observer, "onCancelAck", true);
      const transport = Object.freeze({
        send: candidate.send,
        disconnect: candidate.disconnect
      });
      const send = captureGuardianMethod(transport, "send")!;
      const disconnect = captureGuardianMethod(transport, "disconnect")!;
      const bootstrap = snapshotGuardianBootstrap(candidate.bootstrap as GuardianBootstrap);
      return new CommandGuardianHostProtocolAdapter(
        Object.freeze({
          bootstrap,
          observer: Object.freeze({
            onDurableFrame: onDurableFrame as never,
            ...(onDurablePhase === undefined ? {} : { onDurablePhase: onDurablePhase as never }),
            ...(onDisconnect === undefined ? {} : { onDisconnect: onDisconnect as never }),
            ...(onCancelAck === undefined ? {} : { onCancelAck: onCancelAck as never })
          }),
          send: send as never,
          disconnect: disconnect as never
        }),
        bootstrap
      );
    } catch {
      throw new TypeError("Guardian host protocol is invalid.");
    }
  }

  async transferLease(receiptDigest: string): Promise<void> {
    if (
      this.#transferred ||
      this.#helloNonce === undefined ||
      this.#leaseReceiptDigest !== receiptDigest ||
      !/^[0-9a-f]{64}$/.test(receiptDigest)
    ) {
      throw new TypeError("Guardian host protocol is invalid.");
    }
    this.#transferred = true;
    await this.#sendPayload({
      type: "host.lease_transfer",
      bindingDigest: this.#bindingDigest,
      receiptDigest
    });
  }

  async acknowledgeEvent(sequence: number): Promise<void> {
    if (
      !this.#transferred ||
      !Number.isSafeInteger(sequence) ||
      sequence !== this.#lastEventAck + 1 ||
      sequence > this.#lastFrameSequence
    ) {
      throw new TypeError("Guardian host protocol is invalid.");
    }
    this.#lastEventAck = sequence;
    await this.#sendPayload({ type: "host.event_ack", sequence }, true);
  }

  receive(envelope: GuardianAuthenticatedEnvelope<GuardianToHostPayload>): Promise<void> {
    if (++this.#pendingReceives > MAXIMUM_PENDING_PROTOCOL_MESSAGES) {
      this.#pendingReceives -= 1;
      void this.transportClosed();
      return Promise.reject(new TypeError("Guardian host protocol is saturated."));
    }
    let snapshot: GuardianAuthenticatedEnvelope<GuardianToHostPayload>;
    try {
      snapshot = snapshotSafeJson(
        envelope,
        MAXIMUM_GUARDIAN_ENVELOPE_BYTES
      ) as unknown as GuardianAuthenticatedEnvelope<GuardianToHostPayload>;
    } catch {
      this.#pendingReceives -= 1;
      void this.transportClosed();
      return Promise.reject(new TypeError("Guardian host protocol is invalid."));
    }
    const received = this.#receiveTail.then(async () => await this.#receiveOne(snapshot));
    this.#receiveTail = received.catch(() => undefined);
    return received.finally(() => {
      this.#pendingReceives -= 1;
    });
  }

  transportClosed(): Promise<void> {
    if (this.#state === "open") this.#state = "closing";
    this.#transportClosePromise ??= this.#closeTransport();
    return this.#transportClosePromise;
  }

  async #closeTransport(): Promise<void> {
    if (this.#state === "settled") return;
    try {
      await this.#disconnectOnce();
    } catch {
      // Local settlement is authoritative when the transport is gone.
    }
    this.#state = "settled";
    this.#rejectPendingCancel();
    this.#closedReject(new TypeError("Guardian host transport closed."));
    this.#forgetSecret();
  }

  async #receiveOne(envelope: GuardianAuthenticatedEnvelope<GuardianToHostPayload>): Promise<void> {
    if (this.#state !== "open") throw new TypeError("Guardian host protocol is closed.");
    try {
      const payload = verifyGuardianEnvelope({
        envelope,
        secret: this.#requireSecret(),
        sessionId: this.#sessionId,
        direction: "guardian_to_host",
        expectedSequence: this.#guardianSequence + 1
      });
      this.#guardianSequence += 1;
      if (payload.type === "guardian.hello") {
        if (
          this.#helloNonce !== undefined ||
          !exactProtocolKeys(payload, ["type", "commandId", "bindingDigest", "nonce"]) ||
          payload.commandId !== this.#commandId ||
          payload.bindingDigest !== this.#bindingDigest ||
          !/^[0-9a-f]{64}$/.test(payload.nonce)
        ) {
          throw new TypeError();
        }
        this.#helloNonce = payload.nonce;
        return;
      }
      if (payload.type === "guardian.lease_acquired") {
        if (
          this.#helloNonce === undefined ||
          this.#leaseReceiptDigest !== undefined ||
          !exactProtocolKeys(payload, [
            "type",
            "commandId",
            "bindingDigest",
            "nonceDigest",
            "receiptDigest"
          ]) ||
          payload.commandId !== this.#commandId ||
          payload.bindingDigest !== this.#bindingDigest ||
          payload.nonceDigest !==
            createHash("sha256").update(this.#helloNonce, "utf8").digest("hex") ||
          !/^[0-9a-f]{64}$/.test(payload.receiptDigest)
        ) {
          throw new TypeError();
        }
        this.#leaseReceiptDigest = payload.receiptDigest;
        return;
      }
      if (payload.type === "guardian.released") {
        if (
          this.#helloNonce === undefined ||
          this.#leaseReceiptDigest === undefined ||
          !exactProtocolKeys(payload, ["type", "commandId", "releasedLease"]) ||
          payload.commandId !== this.#commandId ||
          payload.releasedLease !== true ||
          this.#transferred
        ) {
          throw new TypeError();
        }
        this.#state = "settled";
        this.#closedResolve(Object.freeze({ commandId: this.#commandId, releasedLease: true }));
        this.#forgetSecret();
        return;
      }
      if (!this.#transferred) throw new TypeError();
      if (payload.type === "guardian.phase") {
        const phases = [
          "lease_transferred",
          "spawned",
          "running",
          "finalizing",
          "terminal"
        ] as const;
        if (
          !exactProtocolKeys(payload, ["type", "phase", "receiptDigest"]) ||
          payload.phase !== phases[this.#lastPhaseIndex] ||
          !/^[0-9a-f]{64}$/.test(payload.receiptDigest)
        ) {
          throw new TypeError();
        }
        const recovered = await (await this.#durableSpool).recover();
        const durablePhase = recovered.phases[this.#lastPhaseIndex + 1];
        if (
          durablePhase?.phase !== payload.phase ||
          durablePhase.receiptDigest !== payload.receiptDigest
        ) {
          throw new TypeError();
        }
        this.#lastPhaseIndex += 1;
        await this.#invokeObserver((signal) =>
          this.#observer.onDurablePhase?.(payload.phase, payload.receiptDigest, signal)
        );
        return;
      }
      if (payload.type === "guardian.event_committed") {
        const authenticatedFrame = parseFrame(payload.frame);
        const durableSpool = await this.#durableSpool;
        const durableFrame = await durableSpool.readEvent(authenticatedFrame.sequence);
        if (
          !exactProtocolKeys(payload, ["type", "frame"]) ||
          authenticatedFrame.commandId !== this.#commandId ||
          authenticatedFrame.sequence !== this.#lastFrameSequence + 1 ||
          authenticatedFrame.previousFrameDigest !== (this.#lastFrameDigest ?? null) ||
          durableFrame === undefined ||
          canonicalJson(durableFrame) !== canonicalJson(authenticatedFrame)
        ) {
          throw new TypeError();
        }
        this.#lastFrameSequence = authenticatedFrame.sequence;
        this.#lastFrameDigest = authenticatedFrame.frameDigest;
        this.#lastFrameCanonical = canonicalJson(authenticatedFrame);
        await this.#invokeObserver((signal) =>
          this.#observer.onDurableFrame(authenticatedFrame, signal)
        );
        return;
      }
      if (payload.type === "guardian.cancel_ack") {
        if (
          !exactProtocolKeys(payload, ["type", "requestDigest", "claimDigest", "ackDigest"]) ||
          !/^[0-9a-f]{64}$/.test(payload.requestDigest) ||
          !/^[0-9a-f]{64}$/.test(payload.claimDigest) ||
          !/^[0-9a-f]{64}$/.test(payload.ackDigest) ||
          this.#pendingCancel?.requestDigest !== payload.requestDigest
        ) {
          throw new TypeError();
        }
        await this.#invokeObserver((signal) =>
          this.#observer.onCancelAck?.(
            payload.requestDigest,
            payload.claimDigest,
            payload.ackDigest,
            signal
          )
        );
        const pending = this.#pendingCancel;
        this.#pendingCancel = undefined;
        pending.resolve();
        return;
      }
      if (payload.type === "guardian.protocol_failure") {
        if (
          !exactProtocolKeys(payload, ["type", "code"]) ||
          payload.code !== "protocol_failure" ||
          this.#protocolFailureNotified
        ) {
          throw new TypeError();
        }
        this.#protocolFailureNotified = true;
        return;
      }
      if (
        !exactProtocolKeys(payload, ["type", "commandId", "terminalFrame", "releasedLease"]) ||
        payload.type !== "guardian.terminal" ||
        payload.commandId !== this.#commandId ||
        payload.terminalFrame.frameDigest !== this.#lastFrameDigest ||
        canonicalJson(parseFrame(payload.terminalFrame)) !== this.#lastFrameCanonical ||
        this.#lastPhaseIndex !== 5 ||
        (this.#protocolFailureNotified &&
          (payload.terminalFrame.event.type !== "stream.error" ||
            payload.terminalFrame.event.code !== "protocol_failure")) ||
        payload.releasedLease !== true
      ) {
        throw new TypeError();
      }
      const durable = await (await this.#durableSpool).recover();
      if (
        durable.phases.at(-1)?.phase !== "terminal" ||
        canonicalJson(durable.events.at(-1) as never) !== canonicalJson(payload.terminalFrame)
      ) {
        throw new TypeError();
      }
      this.#state = "settled";
      this.#rejectPendingCancel();
      this.#closedResolve(
        Object.freeze({
          commandId: this.#commandId,
          terminalFrame: payload.terminalFrame,
          releasedLease: true
        })
      );
      this.#forgetSecret();
    } catch {
      if (this.#state === "open") {
        this.#state = "closing";
        void this.#teardownProtocolFailure();
        this.#rejectPendingCancel();
        this.#closedReject(new TypeError("Guardian host protocol failed."));
      }
      throw new TypeError("Guardian host protocol failed.");
    }
  }

  async #sendControl(control: GuardianHostControl): Promise<void> {
    if (!this.#transferred || this.#state !== "open")
      throw new TypeError("Guardian host protocol is closed.");
    const payload = parseHostPayload(control);
    if (payload.type !== "host.cancel") {
      await this.#sendPayload(payload);
      return;
    }
    if (this.#pendingCancel !== undefined) {
      if (this.#pendingCancel.requestDigest !== payload.requestDigest) {
        throw new TypeError("Guardian host protocol is closed.");
      }
      return await this.#pendingCancel.promise;
    }
    let resolve!: () => void;
    let reject!: (error: TypeError) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.#pendingCancel = Object.freeze({
      requestDigest: payload.requestDigest,
      resolve,
      reject,
      promise
    });
    try {
      await this.#sendPayload(payload);
      await settleBounded(promise, this.#transportTimeoutMs());
    } catch {
      this.#rejectPendingCancel();
      throw new TypeError("Guardian host protocol failed.");
    }
  }

  async #disconnect(): Promise<void> {
    try {
      await this.#disconnectOnce();
      if (!this.#transferred && this.#state !== "settled") {
        this.#state = "settled";
        this.#closedReject(new TypeError("Guardian release was not authenticated."));
        this.#forgetSecret();
      }
    } catch {
      if (this.#state !== "settled") {
        this.#state = "settled";
        this.#closedReject(new TypeError("Guardian host protocol failed."));
        this.#forgetSecret();
      }
      throw new TypeError("Guardian host protocol failed.");
    }
  }

  async #sendPayload(
    payload: HostToGuardianPayload,
    reentrant = false,
    duringClose = false
  ): Promise<void> {
    if (this.#state !== "open" && !(duringClose && this.#state === "closing")) {
      throw new TypeError("Guardian host protocol is closed.");
    }
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload));
    if (
      this.#pendingSends + 1 > MAXIMUM_PENDING_PROTOCOL_MESSAGES ||
      this.#pendingSendBytes + payloadBytes > MAXIMUM_GUARDIAN_ENVELOPE_BYTES * 2
    ) {
      void this.transportClosed().catch(() => undefined);
      throw new TypeError("Guardian host protocol is saturated.");
    }
    this.#pendingSends += 1;
    this.#pendingSendBytes += payloadBytes;
    const envelope = sealGuardianEnvelope({
      sessionId: this.#sessionId,
      secret: this.#requireSecret(),
      direction: "host_to_guardian",
      sequence: ++this.#hostSequence,
      payload
    });
    const operation = async () => {
      try {
        await this.#invokeTransport(
          (signal) => this.#sendTransport(envelope, signal),
          this.#transportTimeoutMs()
        );
      } catch {
        try {
          await this.#disconnectOnce();
        } catch {
          // The transport failure is already authoritative locally.
        }
        if (this.#state !== "settled") {
          this.#state = "settled";
          this.#closedReject(new TypeError("Guardian host protocol failed."));
          this.#forgetSecret();
        }
        throw new TypeError("Guardian host protocol failed.");
      }
    };
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolveSending!: () => void;
    let rejectSending!: (error: unknown) => void;
    const sending = new Promise<void>((resolve, reject) => {
      resolveSending = resolve;
      rejectSending = reject;
    });
    const invoke = this.#sendInvocationTail.then(() => {
      const running = operation();
      resolveStarted();
      void running.then(resolveSending, rejectSending);
    });
    this.#sendInvocationTail = invoke.then(
      () => undefined,
      () => undefined
    );
    void sending
      .finally(() => {
        this.#pendingSends -= 1;
        this.#pendingSendBytes -= payloadBytes;
      })
      .catch(() => undefined);
    if (reentrant) {
      await started;
      void sending.catch(() => undefined);
      return;
    }
    await sending;
  }

  #rejectPendingCancel(): void {
    const pending = this.#pendingCancel;
    this.#pendingCancel = undefined;
    pending?.reject(new TypeError("Guardian cancel acknowledgement was unavailable."));
  }

  async #teardownProtocolFailure(): Promise<void> {
    this.#protocolTeardownPromise ??= this.#performProtocolFailureTeardown();
    return await this.#protocolTeardownPromise;
  }

  async #performProtocolFailureTeardown(): Promise<void> {
    try {
      await this.#sendPayload(
        { type: "host.protocol_failure", reason: "protocol_failure" },
        false,
        true
      );
    } catch {
      // The transport teardown below is the retained authority boundary.
    }
    try {
      await this.#disconnectOnce();
    } catch {
      // Session remains failed and never attests release.
    } finally {
      this.#state = "settled";
      this.#forgetSecret();
    }
  }

  #disconnectOnce(): Promise<void> {
    this.#disconnectPromise ??= this.#invokeTransport(
      (signal) => this.#disconnectTransport(signal),
      Math.max(this.#transportTimeoutMs(), GUARDIAN_OBSERVER_TIMEOUT_MS * 2)
    );
    return this.#disconnectPromise;
  }

  async #invokeTransport<Value>(
    operation: (signal: AbortSignal) => PromiseLike<Value> | Value,
    timeoutMs?: number
  ): Promise<Value> {
    const outcome = await runAbortableGuardianOperation(operation, timeoutMs);
    if (outcome.status === "completed") return outcome.value;
    if (outcome.status === "timed_out") this.#retainUnsettledTransport(outcome.settled);
    throw new TypeError("Guardian transport did not settle safely.");
  }

  async #invokeObserver(
    operation: (signal: AbortSignal) => PromiseLike<void> | void
  ): Promise<void> {
    const outcome = await runAbortableGuardianOperation(operation, GUARDIAN_OBSERVER_TIMEOUT_MS);
    if (outcome.status === "completed") return;
    if (outcome.status === "timed_out") this.#retainUnsettledTransport(outcome.settled);
    throw new TypeError("Guardian observer did not settle safely.");
  }

  #retainUnsettledTransport(settled: Promise<void>): void {
    this.#unsettledTransport.add(settled);
    this.#transportHeartbeat ??= setInterval(() => undefined, 1_000);
    this.#transportHeartbeat.ref();
    void settled.finally(() => {
      this.#unsettledTransport.delete(settled);
      if (this.#unsettledTransport.size === 0 && this.#transportHeartbeat !== undefined) {
        clearInterval(this.#transportHeartbeat);
        this.#transportHeartbeat = undefined;
      }
    });
  }

  #transportTimeoutMs(): number {
    return Math.max(2_000, Math.min(this.#timeoutMs, 10_000));
  }

  #requireSecret(): Uint8Array {
    if (this.#sessionSecret === undefined) throw new TypeError("Guardian host protocol is closed.");
    return this.#sessionSecret;
  }

  #forgetSecret(): void {
    this.#sessionSecret?.fill(0);
    this.#sessionSecret = undefined;
  }
}

/** Process-side authenticated protocol state machine used by fake IPC and the Task 9 child entry. */

export { CommandGuardianProtocolRuntime } from "./command-guardian-child-runtime.js";
