import type { HealthResponse } from "@autostack/contracts";

import {
  AutoStackHttpClient,
  CliAuthenticationError,
  ControlPlaneUnavailableError
} from "./http-client.js";

export type CliExitCode = 0 | 1 | 2 | 3;

export interface TextWriter {
  write(value: string): unknown;
}

export interface DoctorOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly json: boolean;
}

export interface DoctorDependencies {
  readonly fetch: typeof globalThis.fetch;
  readonly stdout: TextWriter;
  readonly stderr: TextWriter;
}

interface DoctorReport {
  readonly status: "healthy" | "degraded" | "authentication_error" | "unavailable";
  readonly api: "healthy" | "degraded" | "unavailable";
  readonly storage?: "ok" | "degraded";
  readonly journalMode?: "wal";
  readonly schemaVersion?: number;
  readonly executor?: "stopped" | "idle" | "working";
  readonly message?: string;
}

const healthReport = (health: HealthResponse): DoctorReport => ({
  status: health.status === "ok" ? "healthy" : "degraded",
  api: health.status === "ok" ? "healthy" : "degraded",
  storage: health.storage.status,
  journalMode: health.storage.journalMode,
  schemaVersion: health.storage.schemaVersion,
  executor: health.executor.status
});

const humanReport = (report: DoctorReport): string => {
  if (report.api === "unavailable") return `${report.message ?? "Control plane unavailable."}\n`;

  return [
    "AutoStack doctor",
    `API: ${report.api}`,
    `Storage: ${report.storage ?? "unknown"}${report.journalMode === undefined ? "" : ` (${report.journalMode})`}`,
    `Schema: ${report.schemaVersion === undefined ? "unknown" : `v${report.schemaVersion}`}`,
    `Executor: ${report.executor ?? "unknown"}`,
    report.message
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
    .concat("\n");
};

const writeReport = (
  report: DoctorReport,
  json: boolean,
  dependencies: Pick<DoctorDependencies, "stdout" | "stderr">,
  error: boolean
): void => {
  const output = json ? `${JSON.stringify(report)}\n` : humanReport(report);
  (json || !error ? dependencies.stdout : dependencies.stderr).write(output);
};

export async function runDoctor(
  options: DoctorOptions,
  dependencies: DoctorDependencies
): Promise<CliExitCode> {
  const client = new AutoStackHttpClient({
    baseUrl: options.baseUrl,
    token: options.token,
    fetch: dependencies.fetch
  });

  try {
    const health = await client.health();
    const report = healthReport(health);
    if (health.status === "degraded") {
      writeReport(report, options.json, dependencies, false);
      return 3;
    }

    await client.listRuns();
    writeReport(report, options.json, dependencies, false);
    return 0;
  } catch (error) {
    if (error instanceof CliAuthenticationError) {
      writeReport(
        {
          status: "authentication_error",
          api: "unavailable",
          message: "Authentication failed. Check the local API token."
        },
        options.json,
        dependencies,
        true
      );
      return 2;
    }

    const message =
      error instanceof ControlPlaneUnavailableError
        ? "Control plane unavailable. Check that AutoStack is running."
        : "Control plane unavailable.";
    writeReport(
      { status: "unavailable", api: "unavailable", message },
      options.json,
      dependencies,
      true
    );
    return 3;
  }
}
