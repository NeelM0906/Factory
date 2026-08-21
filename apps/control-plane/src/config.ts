import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { WorkspaceIdSchema, type WorkspaceId } from "@autostack/contracts";

export interface ControlPlaneConfig {
  readonly dataDirectory: string;
  readonly token: string;
  readonly host: string;
  readonly port: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const INVALID_TOKEN_PATTERNS = [
  /replace[-_ ]?with/i,
  /change[-_ ]?me/i,
  /placeholder/i,
  /example/i,
  /^(.)\1{31,}$/
] as const;

export function loadConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env
): ControlPlaneConfig {
  const token = environment.AUTOSTACK_LOCAL_API_TOKEN ?? "";
  if (Buffer.byteLength(token, "utf8") < 32) {
    throw new TypeError("AUTOSTACK_LOCAL_API_TOKEN must contain at least 32 bytes.");
  }
  if (INVALID_TOKEN_PATTERNS.some((pattern) => pattern.test(token))) {
    throw new TypeError("AUTOSTACK_LOCAL_API_TOKEN is an example or placeholder value.");
  }

  const host = environment.AUTOSTACK_HOST ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host) && environment.AUTOSTACK_ALLOW_NON_LOOPBACK !== "true") {
    throw new TypeError("Non-loopback binding requires AUTOSTACK_ALLOW_NON_LOOPBACK=true.");
  }

  const portText = environment.AUTOSTACK_PORT ?? "4318";
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("AUTOSTACK_PORT must be an integer from 1 through 65535.");
  }

  return {
    dataDirectory: resolve(environment.AUTOSTACK_DATA_DIR ?? "autostack-data"),
    token,
    host,
    port
  };
}

export function loadOrCreateLocalWorkspaceId(
  dataDirectory: string,
  createWorkspaceId: () => WorkspaceId,
  now: () => string
): WorkspaceId {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const installationPath = join(dataDirectory, "installation.json");
  try {
    const parsed = JSON.parse(readFileSync(installationPath, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new TypeError();
    const record = parsed as Readonly<Record<string, unknown>>;
    if (record.schemaVersion !== 1 || typeof record.createdAt !== "string") throw new TypeError();
    return WorkspaceIdSchema.parse(record.workspaceId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new TypeError("The local installation identity is invalid.");
    }
  }

  const workspaceId = WorkspaceIdSchema.parse(createWorkspaceId());
  let descriptor: number | undefined;
  try {
    descriptor = openSync(installationPath, "wx", 0o600);
    writeFileSync(
      descriptor,
      `${JSON.stringify({ schemaVersion: 1, workspaceId, createdAt: now() })}\n`,
      "utf8"
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  chmodSync(installationPath, 0o600);
  return workspaceId;
}
