/**
 * Codex availability probe.
 *
 * Runs `codex login status` under a bounded timeout, reads its exit status,
 * and passes any surfaced output through redaction. Never reads `~/.codex` (D-6).
 *
 * Unit tests inject the probe and never spawn the real CLI.
 */

import { spawn } from "node:child_process";
import { sanitizeTextField } from "@autostack/agent-adapter-kit";

export interface AvailabilityResult {
  readonly installed: boolean;
  readonly authenticated: boolean;
  readonly detail?: string;
  readonly checkedAt: string;
}

export interface AvailabilityProbeOptions {
  readonly executable: string;
  /** Timeout in ms for the probe (default 10_000). */
  readonly timeoutMs?: number;
}

const buildResult = (
  installed: boolean,
  authenticated: boolean,
  detail: string | undefined,
  checkedAt: string
): AvailabilityResult => {
  const base: AvailabilityResult = { installed, authenticated, checkedAt };
  if (detail != null) return { ...base, detail };
  return base;
};

/**
 * Probe Codex availability by running `<executable> login status`.
 *
 * - Exit 0: installed and authenticated.
 * - Exit non-zero: installed but not authenticated.
 * - spawn failure (ENOENT): not installed.
 *
 * The probe captures stdout+stderr for the detail field, sanitized.
 */
export const probeCodexAvailability = async (
  options: AvailabilityProbeOptions
): Promise<AvailabilityResult> => {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const checkedAt = new Date().toISOString();

  try {
    const { exitCode, output } = await runProbe(options.executable, timeoutMs);

    const detail = sanitizeTextField(output, { maxBytes: 2_000 });

    if (exitCode === 0) {
      return buildResult(true, true, detail, checkedAt);
    }

    return buildResult(true, false, detail, checkedAt);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("ENOENT")) {
      return buildResult(false, false, "Codex executable not found.", checkedAt);
    }

    const detail = sanitizeTextField(message, { maxBytes: 2_000 });
    return buildResult(false, false, detail, checkedAt);
  }
};

const runProbe = (
  executable: string,
  timeoutMs: number
): Promise<{ exitCode: number; output: string }> => {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["login", "status"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs
    });

    const chunks: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));

    child.on("error", reject);
    child.on("close", (code) => {
      const output = Buffer.concat(chunks).toString("utf8");
      resolve({ exitCode: code ?? 1, output });
    });
  });
};
