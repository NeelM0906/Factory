/**
 * A minimal keyed record store for idempotent operations (decision D4). Callers namespace their
 * own keys per operation (e.g. `"github.draft-pull-request:" + idempotencyKey`) so that a draft-PR
 * key and a progress-comment key sharing the same raw idempotency key can never collide -- the
 * store itself is agnostic to what a key represents.
 */
export interface IdempotencyRecordStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

/**
 * `Map`-backed, in-memory only (no persistence in this stream -- durable storage belongs to the
 * pipeline, S4). `set` keeps the FIRST value recorded under a key: a repeated `set` for a key that
 * already has a value is a no-op, which is what makes replaying an idempotent operation safe even
 * if a caller (incorrectly) called `set` more than once for the same result.
 */
export const createMemoryIdempotencyStore = (): IdempotencyRecordStore => {
  const records = new Map<string, unknown>();

  const get = async <T>(key: string): Promise<T | undefined> => records.get(key) as T | undefined;

  const set = async <T>(key: string, value: T): Promise<void> => {
    if (records.has(key)) return;
    records.set(key, value);
  };

  return { get, set };
};
