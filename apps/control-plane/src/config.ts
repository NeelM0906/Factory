import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { WorkspaceIdSchema, type WorkspaceId } from "@autostack/contracts";

export interface ControlPlaneConfig {
  readonly dataDirectory: string;
  readonly token: string;
  readonly host: string;
  readonly port: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function loadConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env
): ControlPlaneConfig {
  const token = environment.AUTOSTACK_LOCAL_API_TOKEN ?? "";
  if (Buffer.byteLength(token, "utf8") < 32) {
    throw new TypeError("AUTOSTACK_LOCAL_API_TOKEN must contain at least 32 bytes.");
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

export function deriveLocalWorkspaceId(token: string): WorkspaceId {
  const bytes = createHash("sha256").update(token).digest().subarray(0, 16);

  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x40, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);

  const hex = bytes.toString("hex");
  const uuid = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");

  return WorkspaceIdSchema.parse(`ws_${uuid}`);
}
