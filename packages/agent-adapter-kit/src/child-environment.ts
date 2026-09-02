/**
 * Spawn-environment policy: ambient authentication is an opaque key-copy over an explicit
 * allowlist (Decision D-5).
 *
 * The child's environment is built from a **frozen** set of allowed variable names, copied
 * key-by-key from the caller's source (typically `process.env`). The value is never read into
 * anything that is logged, scanned, persisted, compared, or placed in an event — it is an
 * opaque key-copy, and the only operation on a value is the assignment itself.
 *
 * This is a different channel from `AgentInvocationRequest.environment`, whose entries are
 * contract-supplied, non-secret, and validated by `NonSecretEnvironmentEntrySchema`. The two
 * share a name rule and nothing else.
 *
 * D-11: Host-injected provider credentials are explicitly excluded. They are the enclosing
 * session's credential, not the user's ambient one.
 */

/**
 * The type an adapter package supplies to extend the common allowlist with its provider's
 * documented authentication variables (pinned from Task 1).
 */
export type ProviderAuthVariables = readonly string[];

/** Name rule from `NonSecretEnvironmentEntrySchema` in `@autostack/contracts`. */
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/u;

/**
 * Common variables forwarded to every provider child. `LC_*` is matched by prefix below,
 * not by enumeration — the list here covers the named non-locale entries.
 */
export const COMMON_ALLOWLIST: readonly string[] = Object.freeze([
  "HOME",
  "PATH",
  "USER",
  "SHELL",
  "LANG",
  "TMPDIR"
]);

/**
 * D-11: Host-injected provider credentials that must never be forwarded, even if they appear
 * in the source environment. Each one is the enclosing session's credential, not the user's.
 */
const BLOCKED_HOST_INJECTED: ReadonlySet<string> = new Set([
  // Claude Code host-session variables
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  // Codex internal overrides
  "CODEX_AUTHAPI_BASE_URL",
  "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"
]);

/**
 * Build the environment record for a child spawn by opaque key-copy over the allowlist.
 *
 * @param source - The environment to copy from (typically `process.env`).
 * @param providerAuthVars - Provider-specific authentication variable names.
 * @returns A frozen plain object suitable for `spawn(..., { env })`.
 */
export const buildChildEnvironment = (
  source: Readonly<Record<string, string | undefined>>,
  providerAuthVars: ProviderAuthVariables
): Readonly<Record<string, string>> => {
  // Validate provider auth variable names against the contract's name rule at construction
  // time, not at copy time — a wrong name is a configuration defect, not a runtime one.
  for (const name of providerAuthVars) {
    if (!ENV_NAME_RE.test(name)) {
      throw new TypeError(
        `Provider auth variable name "${name}" violates the environment name rule.`
      );
    }
  }

  const result: Record<string, string> = Object.create(null) as Record<string, string>;

  // Phase 1: copy common allowlisted names.
  for (const name of COMMON_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) {
      result[name] = value;
    }
  }

  // Phase 2: copy LC_* variables by prefix.
  for (const name of Object.keys(source)) {
    if (name.startsWith("LC_") && ENV_NAME_RE.test(name)) {
      const value = source[name];
      if (value !== undefined) {
        result[name] = value;
      }
    }
  }

  // Phase 3: copy provider-specific auth variables, subject to the D-11 block.
  for (const name of providerAuthVars) {
    if (BLOCKED_HOST_INJECTED.has(name)) {
      continue;
    }
    const value = source[name];
    if (value !== undefined) {
      result[name] = value;
    }
  }

  // Phase 4: scrub any D-11 names that snuck in via the common or LC_* phases.
  // (They should not be there, but the block is structural, not advisory.)
  for (const blocked of BLOCKED_HOST_INJECTED) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete result[blocked];
  }

  return Object.freeze(result);
};
