/** Minimal FIFO keyed lock used for artifact-ID and digest serialization. */
export class KeyedLock {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key)?.catch(() => undefined) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const tail = previous.then(() => gate);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}
