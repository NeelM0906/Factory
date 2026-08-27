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

  // `cause` was accepted and dropped here, which is why a startup failure in CI run 33118019098
  // reported only "The local runner failed closed." with no way to reach what actually failed. It
  // is now retained, and the "no caller-controlled provenance" guarantee above is unchanged: the
  // message and code are still chosen from the fixed table and never derive from the cause. The
  // cause is installed by `Error` as a non-enumerable own property, so it does not appear in
  // `JSON.stringify`, and the host maps this error to an API status by `code` alone -- it is
  // reachable only by code that asks for it, which is exactly the diagnostic path.
  constructor(code: LocalRunnerProviderErrorCode, cause?: unknown) {
    const admitted = Object.hasOwn(ERROR_MESSAGES, code) ? code : "unsafe_state";
    super(ERROR_MESSAGES[admitted], cause === undefined ? undefined : { cause });
    this.name = "LocalRunnerProviderError";
    this.code = admitted;
    Object.freeze(this);
  }
}
