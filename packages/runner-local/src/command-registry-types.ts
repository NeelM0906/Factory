import type { ArtifactDescriptor, CommandId } from "@autostack/contracts";

import type { ArtifactStore } from "./artifact-store.js";
import type { GuardianHostSession } from "./command-guardian.js";
import type {
  DurableRunnerFrame,
  ImmutableRunnerSubscriptionItem,
  ReplaySpool
} from "./replay-spool.js";

export type CommandRegistryErrorCode =
  | "invalid_request"
  | "command_not_found"
  | "command_conflict"
  | "cursor_invalid"
  | "capacity_exceeded"
  | "closed"
  | "maintenance_required"
  | "unsafe_state";

const ERROR_MESSAGES: Readonly<Record<CommandRegistryErrorCode, string>> = Object.freeze({
  invalid_request: "The command registry request is invalid.",
  command_not_found: "The command is unavailable.",
  command_conflict: "The command conflicts with immutable state.",
  cursor_invalid: "The command event cursor is invalid.",
  capacity_exceeded: "The command registry capacity is exhausted.",
  closed: "The command registry is closed.",
  maintenance_required: "The command state requires maintenance.",
  unsafe_state: "The command registry failed closed."
});

export class CommandRegistryError extends Error {
  readonly code: CommandRegistryErrorCode;

  constructor(code: CommandRegistryErrorCode) {
    const admitted = Object.hasOwn(ERROR_MESSAGES, code) ? code : "unsafe_state";
    super(ERROR_MESSAGES[admitted]);
    this.name = "CommandRegistryError";
    this.code = admitted;
    Object.freeze(this);
  }
}

const trustedRegistryErrors = new WeakSet<CommandRegistryError>();

export const createCommandRegistryError = (
  code: CommandRegistryErrorCode
): CommandRegistryError => {
  const error = new CommandRegistryError(code);
  trustedRegistryErrors.add(error);
  return error;
};

export const isTrustedCommandRegistryError = (error: unknown): error is CommandRegistryError =>
  typeof error === "object" &&
  error !== null &&
  trustedRegistryErrors.has(error as CommandRegistryError);

export interface CommandRegistryOptions {
  readonly dataRoot: string;
  readonly artifactStore?: ArtifactStore;
  readonly subscriberQueueFrames?: number;
  readonly subscriberQueueBytes?: number;
  readonly maximumCommands?: number;
  readonly maximumCommandSubscribers?: number;
  readonly maximumSubscribers?: number;
  readonly subscriberIdleMs?: number;
}

export interface CommandRegistryEntry {
  readonly spool: ReplaySpool;
  session?: GuardianHostSession;
  terminal: boolean;
  readonly subscribers: Set<CommandSubscriberState>;
}

export interface CommandCancelRegistration {
  readonly commandId: CommandId;
  readonly cancelled: boolean;
  readonly replayed: boolean;
  readonly session?: GuardianHostSession;
  readonly control?: Extract<
    Parameters<GuardianHostSession["send"]>[0],
    { readonly type: "host.cancel" }
  >;
}

export interface CommandProtocolFailureRegistration {
  readonly commandId: CommandId;
  readonly replayed: boolean;
  readonly session?: GuardianHostSession;
}

export interface CommandSubscriberState {
  readonly commandId: CommandId;
  readonly entry: CommandRegistryEntry;
  cursor: number;
  snapshotHead: number;
  readonly queue: DurableRunnerFrame[];
  queueBytes: number;
  lagged: boolean;
  done: boolean;
  waiter?: () => void;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export interface CommandRegistryInspection {
  resolveOwnedArtifact(request: unknown): Promise<ArtifactDescriptor>;
  subscribe(request: unknown): AsyncIterable<ImmutableRunnerSubscriptionItem>;
}
