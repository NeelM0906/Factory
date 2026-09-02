import { createId, type IdFor, type IdKind } from "@autostack/contracts";

/**
 * A deterministic stand-in for `crypto.randomUUID()`. Every fixture call gets its own counter
 * (never module-scoped), so two `seedFactoryFixture` calls with the same options produce
 * byte-identical IDs. The third group starts with "4" and the fourth with "8" so the value
 * satisfies the UUID v4 shape `packages/contracts/src/ids.ts` requires.
 */
export function buildDeterministicUuid(counter: number): string {
  const hex = counter.toString(16).padStart(30, "0");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(12, 15)}`,
    `8${hex.slice(15, 18)}`,
    hex.slice(18, 30)
  ].join("-");
}

/** A deterministic, injectable replacement for `createIdFactory()` from `@autostack/contracts`. */
export function createDeterministicIdFactory(): <K extends IdKind>(kind: K) => IdFor<K> {
  let counter = 0;
  return (kind) => {
    counter += 1;
    return createId(kind, buildDeterministicUuid(counter));
  };
}

/**
 * A deterministic, injectable clock. Each call advances by one second from a fixed epoch, so
 * sequential fixture writes (created, then transitioned, then decided) land in a coherent order
 * without ever calling `Date.now()`.
 */
export function createDeterministicClock(): () => string {
  const epochMs = Date.parse("2026-08-20T12:00:00.000Z");
  let ticks = 0;
  return () => {
    const value = new Date(epochMs + ticks * 1_000).toISOString();
    ticks += 1;
    return value;
  };
}
