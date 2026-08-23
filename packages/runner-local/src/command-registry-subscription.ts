import type { ReadCommandEventsRequest } from "@autostack/contracts";

import type { CommandRegistry } from "./command-registry.js";
import { createCommandRegistryError } from "./command-registry-types.js";
import type { CommandSubscriberState } from "./command-registry-types.js";
import type { ImmutableRunnerSubscriptionItem } from "./replay-spool.js";

export const closeCommandSubscriberState = (state: CommandSubscriberState): boolean => {
  state.done = true;
  state.queue.splice(0);
  state.queueBytes = 0;
  if (state.idleTimer !== undefined) clearTimeout(state.idleTimer);
  delete state.idleTimer;
  state.waiter?.();
  delete state.waiter;
  return state.entry.subscribers.delete(state);
};

export const closeAllCommandSubscribers = (states: Iterable<CommandSubscriberState>): void => {
  for (const state of states) closeCommandSubscriberState(state);
};

export const armCommandSubscriberIdle = (
  state: CommandSubscriberState,
  idleMs: number,
  close: () => void
): void => {
  if (state.done || state.idleTimer !== undefined) return;
  state.idleTimer = setTimeout(() => {
    delete state.idleTimer;
    close();
  }, idleMs);
  state.idleTimer.unref();
};

export class CommandSubscription implements AsyncIterableIterator<ImmutableRunnerSubscriptionItem> {
  readonly #registry: CommandRegistry;
  readonly #request: ReadCommandEventsRequest;
  #statePromise: Promise<CommandSubscriberState> | undefined;
  #closed = false;
  #nextInFlight = false;

  constructor(registry: CommandRegistry, request: ReadCommandEventsRequest) {
    this.#registry = registry;
    this.#request = request;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<ImmutableRunnerSubscriptionItem> {
    return this;
  }

  async next(): Promise<IteratorResult<ImmutableRunnerSubscriptionItem>> {
    if (this.#closed) return { done: true, value: undefined };
    if (this.#nextInFlight) throw createCommandRegistryError("invalid_request");
    this.#nextInFlight = true;
    try {
      this.#statePromise ??= this.#registry.initializeSubscriber(this.#request);
      return await this.#registry.nextSubscriber(await this.#statePromise);
    } finally {
      this.#nextInFlight = false;
    }
  }

  async return(): Promise<IteratorResult<ImmutableRunnerSubscriptionItem>> {
    this.#closed = true;
    if (this.#statePromise !== undefined) {
      await this.#registry.closeSubscriber(await this.#statePromise);
    }
    return { done: true, value: undefined };
  }
}
