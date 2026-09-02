/**
 * Codex launch profiles.
 *
 * Two profiles, each producing a deterministic argv array (never a shell string):
 *
 * - **app-server**: full interactive JSON-RPC session over stdio. Supports resume
 *   (thread/resume), steering (turn/steer), and permissions (approval requests).
 *   NOTE: `codex app-server` is marked [experimental] by the CLI (finding 18),
 *   so a future CLI upgrade breaking the full profile is a known, named risk.
 * - **exec**: non-interactive `exec --json <objective>`. No resume (continuing
 *   an exec run means a new process, which would be emulated resume per spec §9.1),
 *   no steering, no permissions.
 *
 * D-5: auth variable names are pinned from Task 1's recording.
 * D-9: selection is derived from `-m`/`--model` and `--reasoning-effort` when present.
 */

import type { AgentHarnessDescriptor } from "@autostack/contracts";

// ---- Auth variables (D-5) ----

/**
 * Codex's documented authentication variables, pinned from Task 1.
 * These are forwarded through the opaque key-copy in `buildChildEnvironment`.
 */
export const CODEX_AUTH_VARIABLES: readonly string[] = Object.freeze([
  "OPENAI_API_KEY",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "CODEX_HOME"
]);

// ---- Profile types ----

export interface CodexLaunchProfile {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly descriptor: AgentHarnessDescriptor;
}

export interface AppServerProfileOptions {
  readonly executable: string;
  readonly cwd: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
}

export interface ExecProfileOptions {
  readonly executable: string;
  readonly objective: string;
  readonly cwd: string;
  readonly model?: string;
}

// ---- Builders ----

export const buildAppServerProfile = (
  options: AppServerProfileOptions
): CodexLaunchProfile => {
  const args: string[] = [
    "app-server",
    "-c", "mcp_servers={}"
  ];

  if (options.model != null) {
    args.push("-m", options.model);
  }

  if (options.reasoningEffort != null) {
    args.push("--reasoning-effort", options.reasoningEffort);
  }

  return {
    executable: options.executable,
    args,
    cwd: options.cwd,
    descriptor: {
      schemaVersion: 1 as const,
      adapterId: "codex/app-server",
      kind: "codex",
      displayName: "Codex (app-server)",
      capabilities: {
        resume: true,
        steering: true,
        permissions: true,
        structuredPlans: false
      }
    }
  };
};

export const buildExecProfile = (
  options: ExecProfileOptions
): CodexLaunchProfile => {
  const args: string[] = [
    "exec",
    "--json"
  ];

  if (options.model != null) {
    args.push("-m", options.model);
  }

  // Objective as a trailing positional argument.
  args.push(options.objective);

  return {
    executable: options.executable,
    args,
    cwd: options.cwd,
    descriptor: {
      schemaVersion: 1 as const,
      adapterId: "codex/exec",
      kind: "codex",
      displayName: "Codex (exec)",
      capabilities: {
        resume: false,
        steering: false,
        permissions: false,
        structuredPlans: false
      }
    }
  };
};
