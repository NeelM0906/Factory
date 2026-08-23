import type { ArtifactStore } from "./artifact-store.js";
import type { GuardianBootstrap } from "./command-executor-types.js";
import type { CommandGuardianLaunchOptions, GuardianHostObserver } from "./command-guardian.js";
import type { AtomicPtySpawnAuthority, GuardianAuthenticatedEnvelope } from "./pty.js";
import type { DurableRunnerFrame } from "./replay-spool.js";
import type { HostToGuardianPayload } from "./command-guardian-protocol-codec.js";

export type GuardianToHostPayload =
  | Readonly<{
      readonly type: "guardian.hello";
      readonly commandId: string;
      readonly bindingDigest: string;
      readonly nonce: string;
    }>
  | Readonly<{
      readonly type: "guardian.lease_acquired";
      readonly commandId: string;
      readonly bindingDigest: string;
      readonly nonceDigest: string;
      readonly receiptDigest: string;
    }>
  | Readonly<{
      readonly type: "guardian.phase";
      readonly phase: "lease_transferred" | "spawned" | "running" | "finalizing" | "terminal";
      readonly receiptDigest: string;
    }>
  | Readonly<{ readonly type: "guardian.event_committed"; readonly frame: DurableRunnerFrame }>
  | Readonly<{
      readonly type: "guardian.cancel_ack";
      readonly requestDigest: string;
      readonly claimDigest: string;
      readonly ackDigest: string;
    }>
  | Readonly<{
      readonly type: "guardian.released";
      readonly commandId: string;
      readonly releasedLease: true;
    }>
  | Readonly<{
      readonly type: "guardian.terminal";
      readonly commandId: string;
      readonly terminalFrame: DurableRunnerFrame;
      readonly releasedLease: boolean;
    }>
  | Readonly<{ readonly type: "guardian.protocol_failure"; readonly code: "protocol_failure" }>;

export interface AdmittedGuardianChildProtocolOptions extends Omit<
  CommandGuardianLaunchOptions,
  "observer" | "acquiredLease"
> {
  readonly commandId: GuardianBootstrap["commandId"];
  readonly session: GuardianBootstrap["session"];
  readonly send: (
    message: GuardianAuthenticatedEnvelope<GuardianToHostPayload>,
    signal: AbortSignal
  ) => Promise<void> | void;
  readonly createNonce?: () => Uint8Array;
}

export interface GuardianChildRuntimeOptions {
  readonly bootstrap: GuardianBootstrap;
  readonly artifactStore: ArtifactStore;
  readonly spawnAuthority: AtomicPtySpawnAuthority;
  readonly now: () => string;
  readonly monotonicNowMs: () => number;
  readonly send: (
    message: GuardianAuthenticatedEnvelope<GuardianToHostPayload>,
    signal: AbortSignal
  ) => Promise<void> | void;
  readonly createNonce?: () => Uint8Array;
}

export interface GuardianHostProtocolAdapterOptions {
  readonly bootstrap: GuardianBootstrap;
  readonly observer: GuardianHostObserver;
  readonly send: (
    message: GuardianAuthenticatedEnvelope<HostToGuardianPayload>,
    signal: AbortSignal
  ) => Promise<void> | void;
  readonly disconnect: (signal: AbortSignal) => Promise<void> | void;
}
