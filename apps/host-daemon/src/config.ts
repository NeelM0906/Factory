import { z } from "zod";

import { GuardianLaunchDescriptorSchema, normalizeSafeJson } from "@autostack/contracts";

const HostTokenSchema = z
  .string()
  .refine((value) => Buffer.byteLength(value, "utf8") >= 32, "Host token is too short.")
  .refine((value) => Buffer.byteLength(value, "utf8") <= 4_096, "Host token is too long.")
  .refine(
    (value) => !/(replace-with|change-me|placeholder|example)/i.test(value),
    "Host token is unsafe."
  )
  .refine((value) => !/^(.)\1+$/su.test(value), "Host token is unsafe.");

const PrivateDataRootSchema = z
  .string()
  .min(1)
  .max(8_192)
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.includes("\0") &&
      !value.includes("\\") &&
      !value.split("/").some((part) => part === "." || part === ".."),
    "A canonical absolute POSIX data root is required."
  );

export const HostDaemonBootstrapSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("host.bootstrap"),
    hostToken: HostTokenSchema,
    dataRoot: PrivateDataRootSchema,
    host: z.literal("127.0.0.1"),
    port: z.literal(0),
    guardian: GuardianLaunchDescriptorSchema
  })
  .strict();

export type HostDaemonBootstrap = z.infer<typeof HostDaemonBootstrapSchema>;

export interface BootstrapReader {
  readOnce(signal: AbortSignal): Promise<unknown>;
}

const FORBIDDEN_OVERRIDES = [
  "AUTOSTACK_HOST_TOKEN",
  "AUTOSTACK_HOST_DAEMON_TOKEN",
  "AUTOSTACK_HOST_DAEMON_DATA_ROOT",
  "AUTOSTACK_GUARDIAN_MODULE",
  "AUTOSTACK_GUARDIAN_NATIVE_DIR",
  "AUTOSTACK_GUARDIAN_MANIFEST",
  "AUTOSTACK_HOST",
  "AUTOSTACK_PORT"
] as const;

export const rejectHostEnvironmentOverrides = (
  environment: Readonly<Record<string, string | undefined>>
): void => {
  if (FORBIDDEN_OVERRIDES.some((name) => environment[name] !== undefined)) {
    throw new TypeError("Host configuration overrides are forbidden.");
  }
};

export const parseHostBootstrap = (candidate: unknown): HostDaemonBootstrap =>
  HostDaemonBootstrapSchema.parse(normalizeSafeJson(candidate));

export const readHostBootstrapOnce = async (
  reader: BootstrapReader,
  signal: AbortSignal
): Promise<HostDaemonBootstrap> => parseHostBootstrap(await reader.readOnce(signal));
