/**
 * Bounded, in-memory, per-process seen-set for GitHub `X-GitHub-Delivery` ids.
 *
 * This is an edge optimisation only, not a durable dedup mechanism: it exists so an exact
 * re-POST of the same delivery (GitHub's own retry, or an operator-triggered redelivery) can be
 * answered without re-entering the pipeline. It is not persisted, is not shared across
 * processes, and is bounded in size, so it cannot be relied on to catch every duplicate over the
 * lifetime of a delivery. The durable dedup authority is `IntegrationIngressPort.accept`
 * (decision D5, spec §17), which recognises the same *logical* event (via `deduplicationKey`)
 * regardless of how many delivery ids it arrived under or how long ago the first one was seen.
 */
export interface CreateDeliveryReplayGuardOptions {
  readonly capacity?: number;
}

export interface DeliveryReplayGuard {
  /** Returns `false` the first time `deliveryId` is seen, `true` on every subsequent call. */
  readonly seen: (deliveryId: string) => boolean;
}

const DEFAULT_CAPACITY = 4096;

export const createDeliveryReplayGuard = (
  options: CreateDeliveryReplayGuardOptions = {}
): DeliveryReplayGuard => {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;

  // A `Set` iterates in insertion order, so its first entry is always the oldest -- exactly the
  // FIFO eviction a bounded seen-set needs. Evicting anything else (e.g. the entry just
  // inserted) would forget a recent id instead of an old one.
  const ids = new Set<string>();

  return {
    seen: (deliveryId: string): boolean => {
      if (ids.has(deliveryId)) return true;

      if (ids.size >= capacity) {
        const oldest = ids.values().next().value;
        if (oldest !== undefined) ids.delete(oldest);
      }
      ids.add(deliveryId);
      return false;
    }
  };
};
