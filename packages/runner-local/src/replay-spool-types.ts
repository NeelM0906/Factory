import type {
  ArtifactId,
  CommandAuthorizationId,
  CommandId,
  EnvironmentAuthorizationId,
  EnvironmentId,
  RunId,
  RunnerSubscriptionItem,
  RunnerStreamEvent,
  SafeJsonValue,
  WorkspaceId
} from "@autostack/contracts";

import type { ReplaySpool } from "./replay-spool.js";

export type DeepReadonly<Value> = Value extends
  null | undefined | string | number | boolean | bigint | symbol
  ? Value
  : Value extends (...arguments_: never[]) => unknown
    ? Value
    : Value extends readonly unknown[]
      ? { readonly [Index in keyof Value]: DeepReadonly<Value[Index]> }
      : Value extends object
        ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
        : Value;

export type ImmutableRunnerStreamEvent = DeepReadonly<RunnerStreamEvent>;
export type ImmutableRunnerSubscriptionItem = DeepReadonly<RunnerSubscriptionItem>;

export type ReplaySpoolErrorCode =
  | "invalid_input"
  | "command_conflict"
  | "invalid_transition"
  | "maintenance_required"
  | "unsafe_state";

export interface CommandExecutionLimits {
  readonly eventBytes: number;
  readonly replayBytes: number;
  readonly transcriptBytes: number;
  readonly cancellationGraceMs: number;
  readonly eofSettleMs: number;
}

export interface CommandIntentInput {
  readonly commandId: CommandId;
  readonly workspaceId: WorkspaceId;
  readonly runId: RunId;
  readonly environmentId: EnvironmentId;
  readonly request: unknown;
  readonly requestDigest: string;
  readonly environmentIntentDigest: string;
  readonly environmentAuthorizationId: EnvironmentAuthorizationId;
  readonly environmentAuthorizationDigest: string;
  readonly environmentAuthorization: unknown;
  readonly commandAuthorizationId: CommandAuthorizationId;
  readonly commandAuthorizationDigest: string;
  readonly acceptedAt: string;
  readonly executablePath: string;
  readonly executableIdentityDigest: string;
  readonly cwdRelativePath: string;
  readonly cwdIdentityDigest: string;
  readonly spawnEnvelopeDigest: string;
  readonly transcriptArtifactId: ArtifactId;
  readonly artifactCreatedAt: string;
  readonly guardianSessionBindingDigest: string;
  readonly limits: CommandExecutionLimits;
}

export interface AdmittedCommandIntent {
  readonly commandId: CommandId;
  readonly workspaceId: WorkspaceId;
  readonly runId: RunId;
  readonly environmentId: EnvironmentId;
  readonly request: SafeJsonValue;
  readonly requestDigest: string;
  readonly environmentIntentDigest: string;
  readonly environmentAuthorizationId: EnvironmentAuthorizationId;
  readonly environmentAuthorizationDigest: string;
  readonly environmentAuthorization: SafeJsonValue;
  readonly commandAuthorizationId: CommandAuthorizationId;
  readonly commandAuthorizationDigest: string;
  readonly acceptedAt: string;
  readonly executablePath: string;
  readonly executableIdentityDigest: string;
  readonly cwdRelativePath: string;
  readonly cwdIdentityDigest: string;
  readonly spawnEnvelopeDigest: string;
  readonly transcriptArtifactId: ArtifactId;
  readonly artifactCreatedAt: string;
  readonly guardianSessionBindingDigest: string;
  readonly limits: CommandExecutionLimits;
}

export interface CommandIntentReceipt extends AdmittedCommandIntent {
  readonly version: 1;
  readonly kind: "command_receipt";
  readonly phase: "intent";
  readonly sequence: 1;
  readonly previousReceiptDigest: null;
  readonly receiptDigest: string;
}

export interface DurableRunnerFrame {
  readonly version: 1;
  readonly kind: "runner_frame";
  readonly commandId: CommandId;
  readonly sequence: number;
  readonly previousFrameDigest: string | null;
  readonly event: ImmutableRunnerStreamEvent;
  readonly eventDigest: string;
  readonly frameDigest: string;
}

export type CommandReceiptPhaseName =
  "intent" | "lease_transferred" | "spawned" | "running" | "finalizing" | "terminal";

export const RECEIPT_PHASES = Object.freeze([
  "intent",
  "lease_transferred",
  "spawned",
  "running",
  "finalizing",
  "terminal"
] as const satisfies readonly CommandReceiptPhaseName[]);

export const RECEIPT_NAMES = Object.freeze([
  "01-intent.json",
  "02-lease-transferred.json",
  "03-spawned.json",
  "04-running.json",
  "05-finalizing.json",
  "06-terminal.json"
] as const);

export interface CommandPhaseReceipt {
  readonly version: 1;
  readonly kind: "command_receipt";
  readonly phase: Exclude<CommandReceiptPhaseName, "intent">;
  readonly sequence: 2 | 3 | 4 | 5 | 6;
  readonly commandId: CommandId;
  readonly previousReceiptDigest: string;
  readonly recordedAt: string;
  readonly evidence: SafeJsonValue;
  readonly receiptDigest: string;
}

export interface RecordCommandPhaseInput {
  readonly recordedAt: string;
  readonly evidence: unknown;
}

export interface TranscriptChunkEvidence {
  readonly ordinal: number;
  readonly previousChunkDigest: string | null;
  readonly contentDigest: string;
  readonly byteSize: number;
  readonly cumulativeByteSize: number;
  readonly chunkDigest: string;
}

export interface RecoveredTranscriptChunk extends TranscriptChunkEvidence {
  readonly bytes: Buffer;
}

export interface RecoveredCommandSpool {
  readonly intent: CommandIntentReceipt;
  readonly phases: readonly (CommandIntentReceipt | CommandPhaseReceipt)[];
  readonly events: readonly DurableRunnerFrame[];
  readonly eventByteSize: number;
  readonly transcriptChunks: readonly RecoveredTranscriptChunk[];
  readonly transcriptByteSize: number;
  readonly cancel?: CommandCancelClaim;
  readonly cancelAck?: CommandCancelAck;
}

export interface RecordCommandCancelInput {
  readonly requestDigest: string;
  readonly decidedAt: string;
  readonly cancelled: boolean;
}

export interface CommandCancelClaim {
  readonly version: 1;
  readonly kind: "command_cancel";
  readonly commandId: CommandId;
  readonly requestDigest: string;
  readonly decidedAt: string;
  readonly cancelled: boolean;
  readonly claimDigest: string;
}

export interface CommandCancelDecision extends CommandCancelClaim {
  readonly replayed: boolean;
}

export interface CommandCancelAck {
  readonly version: 1;
  readonly kind: "command_cancel_ack";
  readonly commandId: CommandId;
  readonly claimDigest: string;
  readonly acknowledgedAt: string;
  readonly signalDispatched: true;
  readonly ackDigest: string;
}

export interface ReplaySpoolRegistration {
  readonly spool: ReplaySpool;
  readonly receipt: CommandIntentReceipt;
  readonly replayed: boolean;
  readonly intentRelativePath: string;
}

export interface ReplaySpoolRegisterOptions {
  readonly dataRoot: string;
  readonly intent: CommandIntentInput;
  readonly createAttemptId?: () => string;
  readonly publicationHook?: ReplaySpoolPublicationHook;
}

export interface ReplaySpoolOpenOptions {
  readonly dataRoot: string;
  readonly commandId: CommandId;
  readonly createAttemptId?: () => string;
}

export type ReplaySpoolPublicationStage =
  | "temp-created"
  | "file-synced"
  | "temp-directory-synced"
  | "canonical-linked"
  | "canonical-directory-synced"
  | "alias-unlinked"
  | "alias-directory-synced";

export type ReplaySpoolPublicationHook = (
  relativePath: string,
  stage: ReplaySpoolPublicationStage
) => Promise<void> | void;
