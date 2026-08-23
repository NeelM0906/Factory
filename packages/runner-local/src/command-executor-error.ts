export type CommandExecutorErrorCode =
  | "invalid_request"
  | "command_conflict"
  | "environment_conflict"
  | "execution_unavailable"
  | "closed"
  | "maintenance_required"
  | "unsafe_state";

const ERROR_MESSAGES = Object.freeze({
  invalid_request: "The command request is invalid.",
  command_conflict: "The command conflicts with immutable command state.",
  environment_conflict: "The prepared environment conflicts with the command request.",
  execution_unavailable: "The command could not be started safely.",
  closed: "The command executor is closed.",
  maintenance_required: "The command state requires maintenance.",
  unsafe_state: "The command executor failed closed."
} satisfies Readonly<Record<CommandExecutorErrorCode, string>>);

export class CommandExecutorError extends Error {
  readonly code: CommandExecutorErrorCode;

  constructor(code: CommandExecutorErrorCode) {
    const admitted = Object.hasOwn(ERROR_MESSAGES, code) ? code : "unsafe_state";
    super(ERROR_MESSAGES[admitted]);
    this.name = "CommandExecutorError";
    this.code = admitted;
    Object.freeze(this);
  }
}

const trustedExecutorErrors = new WeakSet<CommandExecutorError>();

export const createCommandExecutorError = (
  code: CommandExecutorErrorCode
): CommandExecutorError => {
  const error = new CommandExecutorError(code);
  trustedExecutorErrors.add(error);
  return error;
};

const isTrustedCommandExecutorError = (error: unknown): error is CommandExecutorError =>
  typeof error === "object" &&
  error !== null &&
  trustedExecutorErrors.has(error as CommandExecutorError);

export const safeCommandTimestamp = (clock: () => string): string => {
  try {
    const value = clock();
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new TypeError();
    return new Date(value).toISOString();
  } catch {
    throw createCommandExecutorError("unsafe_state");
  }
};

export const admitPositiveBoundedInteger = (value: unknown, maximum: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new TypeError();
  }
  return value as number;
};

export const mapCommandRegistryError = (error: unknown): CommandExecutorError => {
  if (isTrustedCommandExecutorError(error)) {
    return createCommandExecutorError(error.code);
  }
  if (isTrustedCommandRegistryError(error)) {
    if (error.code === "command_conflict") return createCommandExecutorError("command_conflict");
    if (error.code === "maintenance_required") {
      return createCommandExecutorError("maintenance_required");
    }
    if (error.code === "invalid_request" || error.code === "cursor_invalid") {
      return createCommandExecutorError("invalid_request");
    }
    if (error.code === "closed") return createCommandExecutorError("closed");
  }
  return createCommandExecutorError("unsafe_state");
};
import { isTrustedCommandRegistryError } from "./command-registry-types.js";
