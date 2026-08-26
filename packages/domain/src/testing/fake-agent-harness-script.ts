import type { AgentPermissionOption, AgentSessionStreamEvent } from "@autostack/contracts";

/**
 * The event context (`schemaVersion`, `sessionId`, `sequence`, `occurredAt`) is owned by the fake so
 * that sequence numbers stay monotonic and timestamps come from the injected clock. A script only
 * declares the discriminated payload, of any lifecycle or normalized detail event the port carries.
 */
type WithoutSessionContext<Event> = Event extends unknown
  ? Omit<Event, "schemaVersion" | "sessionId" | "sequence" | "occurredAt">
  : never;

export type FakeHarnessEventTemplate = WithoutSessionContext<AgentSessionStreamEvent>;

/** The permission round trip a script step opens; the fake supplies session and timestamp. */
export interface FakeHarnessPermissionTemplate {
  readonly permissionRef: string;
  readonly summary: string;
  readonly evidenceDigest: string;
  readonly options: readonly AgentPermissionOption[];
}

/**
 * One declared move of a session. `emit` produces an event, `await_steer` and `await_permission`
 * block the stream until the consumer drives it, and `throw` injects a transport-level failure.
 */
export type FakeHarnessScriptStep =
  | { readonly kind: "emit"; readonly event: FakeHarnessEventTemplate }
  | { readonly kind: "await_steer"; readonly reason: string }
  | { readonly kind: "await_permission"; readonly permission: FakeHarnessPermissionTemplate }
  | { readonly kind: "throw"; readonly error: Error };

/**
 * The ordered steps of one session. `start` consumes the script from the beginning and `resume`
 * continues from wherever the previous stream stopped, so a multi-turn session is one list.
 */
export type FakeHarnessScript = readonly FakeHarnessScriptStep[];
