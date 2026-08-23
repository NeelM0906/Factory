import type { ReplaySpoolErrorCode } from "./replay-spool-types.js";

const ERROR_MESSAGES: Readonly<Record<ReplaySpoolErrorCode, string>> = Object.freeze({
  invalid_input: "The command spool request is invalid.",
  command_conflict: "The command ID conflicts with immutable command state.",
  invalid_transition: "The command spool transition is invalid.",
  maintenance_required: "The command spool requires maintenance.",
  unsafe_state: "The command spool failed closed."
});

export class ReplaySpoolError extends Error {
  readonly code: ReplaySpoolErrorCode;

  constructor(code: ReplaySpoolErrorCode) {
    const admitted = Object.hasOwn(ERROR_MESSAGES, code) ? code : "unsafe_state";
    super(ERROR_MESSAGES[admitted]);
    this.name = "ReplaySpoolError";
    this.code = admitted;
    trustedReplaySpoolErrors.add(this);
    Object.freeze(this);
  }
}

const trustedReplaySpoolErrors = new WeakSet<ReplaySpoolError>();

export const isReplaySpoolError = (error: unknown): error is ReplaySpoolError =>
  typeof error === "object" &&
  error !== null &&
  trustedReplaySpoolErrors.has(error as ReplaySpoolError);
