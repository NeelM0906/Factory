import type { RunnerStreamEvent } from "@autostack/contracts";

import type { GuardianHostObserver } from "./command-guardian-types.js";
import type { DurableRunnerFrame, ReplaySpool } from "./replay-spool.js";
import { GUARDIAN_OBSERVER_TIMEOUT_MS, settleBounded } from "./command-guardian-bounds.js";

type EventBaseKey = "workspaceId" | "runId" | "commandId" | "sequence" | "occurredAt";
export type GuardianEventInput<Event = RunnerStreamEvent> = Event extends RunnerStreamEvent
  ? Omit<Event, EventBaseKey>
  : never;

export class GuardianDurableRecorder {
  readonly #spool: ReplaySpool;
  readonly #observer: GuardianHostObserver;
  readonly #now: () => string;
  #lastReceiptMs: number;

  constructor(spool: ReplaySpool, observer: GuardianHostObserver, now: () => string) {
    this.#spool = spool;
    this.#observer = observer;
    this.#now = now;
    this.#lastReceiptMs = Date.parse(spool.intent.acceptedAt);
  }

  receiptTime(): string {
    const candidate = this.#now();
    const parsed = Date.parse(candidate);
    if (!Number.isFinite(parsed)) throw new TypeError("Guardian clock is invalid.");
    this.#lastReceiptMs = Math.max(parsed, this.#lastReceiptMs + 1);
    return new Date(this.#lastReceiptMs).toISOString();
  }

  async appendEvent(
    event: GuardianEventInput,
    reserveReplayBytes = 0,
    notify = true
  ): Promise<DurableRunnerFrame> {
    const sequence = (await this.#spool.head()) + 1;
    const occurredAt = this.#now();
    if (!Number.isFinite(Date.parse(occurredAt))) throw new TypeError("Guardian clock is invalid.");
    const durable = await this.#spool.appendEvent(
      {
        ...event,
        workspaceId: this.#spool.intent.workspaceId,
        runId: this.#spool.intent.runId,
        commandId: this.#spool.intent.commandId,
        sequence,
        occurredAt: new Date(occurredAt).toISOString()
      } as RunnerStreamEvent,
      { reserveReplayBytes }
    );
    if (notify) await this.notifyFrame(durable);
    return durable;
  }

  async notifyFrame(frame: DurableRunnerFrame): Promise<void> {
    try {
      await settleBounded(this.#observer.onDurableFrame(frame), GUARDIAN_OBSERVER_TIMEOUT_MS);
    } catch {
      // Notification follows durability and never rolls back evidence.
    }
  }

  async notifyPhase(
    phase: "lease_transferred" | "spawned" | "running" | "finalizing" | "terminal",
    receiptDigest: string
  ): Promise<void> {
    try {
      await settleBounded(
        this.#observer.onDurablePhase?.(phase, receiptDigest),
        GUARDIAN_OBSERVER_TIMEOUT_MS
      );
    } catch {
      // Phase notification follows durability and never rolls back evidence.
    }
  }
}
