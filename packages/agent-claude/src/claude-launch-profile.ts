/**
 * Claude Code launch profiles.
 *
 * Two profiles, each producing a deterministic argv array (never a shell string):
 *
 * - **streaming**: full interactive session with `--session-id`, `--input-format stream-json`,
 *   `--permission-mode manual`. Supports resume, steering, and permissions.
 * - **batch**: non-interactive `--output-format stream-json --verbose`. No session identity,
 *   no resume, no steering, no permissions.
 *
 * The session id in the streaming profile is minted by the adapter, not discovered from the
 * provider — provider session identity is pinned rather than deferred.
 *
 * D-5: auth variable names are pinned from Task 1's recording.
 * D-9: selection is derived from `--model` and `--effort` flags when present.
 */

import type { AgentHarnessDescriptor } from "@autostack/contracts";

// ---- Auth variables (D-5) ----

/**
 * Claude Code's documented authentication variables, pinned from Task 1.
 * These are forwarded through the opaque key-copy in `buildChildEnvironment`.
 */
export const CLAUDE_AUTH_VARIABLES: readonly string[] = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "VERTEX_REGION",
  "VERTEX_PROJECT"
]);

// ---- Profile types ----

export interface ClaudeLaunchProfile {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly descriptor: AgentHarnessDescriptor;
}

export interface StreamingProfileOptions {
  readonly executable: string;
  readonly objective: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly model?: string;
  readonly resume?: boolean;
}

export interface BatchProfileOptions {
  readonly executable: string;
  readonly objective: string;
  readonly cwd: string;
  readonly model?: string;
}

// ---- Builders ----

export const buildStreamingProfile = (options: StreamingProfileOptions): ClaudeLaunchProfile => {
  const args: string[] = [
    "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--session-id", options.sessionId,
    "--permission-mode", "manual"
  ];

  if (options.model != null) {
    args.push("--model", options.model);
  }

  if (options.resume === true) {
    args.push("--resume");
  }

  // Objective as a trailing positional argument, never interpolated into a flag.
  args.push(options.objective);

  return {
    executable: options.executable,
    args,
    cwd: options.cwd,
    descriptor: {
      schemaVersion: 1 as const,
      adapterId: "claude-code/streaming",
      kind: "claude",
      displayName: "Claude Code",
      capabilities: {
        resume: true,
        steering: true,
        permissions: true,
        structuredPlans: false
      }
    }
  };
};

export const buildBatchProfile = (options: BatchProfileOptions): ClaudeLaunchProfile => {
  const args: string[] = [
    "-p",
    "--output-format", "stream-json",
    "--verbose"
  ];

  if (options.model != null) {
    args.push("--model", options.model);
  }

  // Objective as a trailing positional argument.
  args.push(options.objective);

  return {
    executable: options.executable,
    args,
    cwd: options.cwd,
    descriptor: {
      schemaVersion: 1 as const,
      adapterId: "claude-code/batch",
      kind: "claude",
      displayName: "Claude Code (batch)",
      capabilities: {
        resume: false,
        steering: false,
        permissions: false,
        structuredPlans: false
      }
    }
  };
};
