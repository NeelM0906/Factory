export type LocalRunnerProviderErrorCode =
  | "invalid_request"
  | "closed"
  | "root_busy"
  | "conflict"
  | "invalid_path"
  | "authorization_mismatch"
  | "authorization_stale"
  | "unsupported_policy"
  | "environment_not_prepared"
  | "command_not_found"
  | "artifact_not_found"
  | "terminal_evidence_invalid"
  | "active_command"
  | "active_run"
  | "dirty_worktree"
  | "missing_credential"
  | "maintenance_required"
  | "unsafe_state";

const ERROR_MESSAGES = Object.freeze({
  invalid_request: "The local runner request is invalid.",
  closed: "The local runner is closed.",
  root_busy: "The AutoStack data root is busy.",
  conflict: "The request conflicts with immutable local runner state.",
  invalid_path: "The requested path is invalid.",
  authorization_mismatch: "The request does not match its authorization.",
  authorization_stale: "The authorization is not currently valid.",
  unsupported_policy: "The requested execution policy is unsupported.",
  environment_not_prepared: "The environment is not prepared.",
  command_not_found: "The command is unavailable.",
  artifact_not_found: "The artifact is unavailable.",
  terminal_evidence_invalid: "The terminal run evidence is invalid.",
  active_command: "The environment has an active command.",
  active_run: "The run is still active.",
  dirty_worktree: "The managed worktree has local changes.",
  missing_credential: "A required credential is unavailable.",
  maintenance_required: "The local runner requires maintenance.",
  unsafe_state: "The local runner failed closed."
} satisfies Readonly<Record<LocalRunnerProviderErrorCode, string>>);

/** Stable local-runner failure with no caller-controlled provenance. */
export class LocalRunnerProviderError extends Error {
  readonly code: LocalRunnerProviderErrorCode;

  constructor(code: LocalRunnerProviderErrorCode, _cause?: unknown) {
    const admitted = Object.hasOwn(ERROR_MESSAGES, code) ? code : "unsafe_state";
    super(ERROR_MESSAGES[admitted]);
    this.name = "LocalRunnerProviderError";
    this.code = admitted;
    Object.freeze(this);
  }
}
