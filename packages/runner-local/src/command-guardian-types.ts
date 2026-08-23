import type { ArtifactStore } from "./artifact-store.js";
import type { CommandGuardianLease } from "./data-root-lock.js";
import type { AtomicPtySpawnAuthority, PtySpawnRequest } from "./pty.js";
import type { DurableRunnerFrame, ReplaySpool } from "./replay-spool.js";

export type GuardianTerminalCause =
  "natural" | "cancelled" | "timeout" | "interrupted" | "protocol_failure" | "output_quarantined";

export interface GuardianTerminalEvidence {
  readonly cause: GuardianTerminalCause;
  readonly exit: Readonly<{ readonly exitCode: number | null; readonly signal: string | null }>;
  readonly processTreeTerminated: boolean;
  readonly ptyEofObserved: boolean;
}

export type GuardianHostControl =
  | Readonly<{ readonly type: "host.input"; readonly value: string }>
  | Readonly<{ readonly type: "host.resize"; readonly columns: number; readonly rows: number }>
  | Readonly<{
      readonly type: "host.cancel";
      readonly reason: "user";
      readonly requestDigest: string;
      readonly decidedAt: string;
    }>
  | Readonly<{ readonly type: "host.interrupt" }>
  | Readonly<{
      readonly type: "host.protocol_failure";
      readonly reason: "output_quarantined";
    }>;

export interface GuardianCloseOutcome {
  readonly commandId: ReplaySpool["intent"]["commandId"];
  readonly terminalFrame?: DurableRunnerFrame;
  readonly releasedLease: boolean;
}

export class GuardianSupervisionError extends Error {
  readonly code: "unsafe_state" | "maintenance_required";

  constructor(code: "unsafe_state" | "maintenance_required") {
    super(
      code === "unsafe_state"
        ? "Guardian supervision authority is retained."
        : "Guardian command state requires maintenance."
    );
    this.name = "GuardianSupervisionError";
    this.code = code;
    trustedGuardianSupervisionErrors.add(this);
    Object.freeze(this);
  }
}

const trustedGuardianSupervisionErrors = new WeakSet<GuardianSupervisionError>();

export const isGuardianSupervisionError = (error: unknown): error is GuardianSupervisionError =>
  typeof error === "object" &&
  error !== null &&
  trustedGuardianSupervisionErrors.has(error as GuardianSupervisionError);

export interface GuardianHostSession {
  readonly sessionId: string;
  send(message: GuardianHostControl): Promise<void>;
  disconnect(): Promise<void>;
  readonly closed: Promise<GuardianCloseOutcome>;
}

export interface GuardianHostObserver {
  onDurableFrame(frame: DurableRunnerFrame, signal?: AbortSignal): Promise<void> | void;
  onDurablePhase?(
    phase: "lease_transferred" | "spawned" | "running" | "finalizing" | "terminal",
    receiptDigest: string,
    signal?: AbortSignal
  ): Promise<void> | void;
  onDisconnect?(signal?: AbortSignal): Promise<void> | void;
  onCancelAck?(
    requestDigest: string,
    claimDigest: string,
    ackDigest: string,
    signal?: AbortSignal
  ): Promise<void> | void;
}

export interface CommandGuardianLaunchOptions {
  readonly dataRoot: string;
  readonly spool: ReplaySpool;
  readonly artifactStore: ArtifactStore;
  readonly spawnAuthority: AtomicPtySpawnAuthority;
  readonly envelope: PtySpawnRequest;
  readonly sensitiveValues: readonly string[];
  readonly timeoutMs: number;
  readonly cancellationGraceMs: number;
  readonly eofSettleMs: number;
  readonly now: () => string;
  readonly monotonicNowMs: () => number;
  readonly observer: GuardianHostObserver;
  readonly acquiredLease?: CommandGuardianLease;
  readonly guardianNonceDigest?: string;
}
