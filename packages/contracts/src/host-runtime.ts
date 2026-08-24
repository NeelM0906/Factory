import { z } from "zod";

import { RunnerDrainResultSchema } from "./runner.js";

const RuntimeAbsolutePathSchema = z
  .string()
  .min(1)
  .max(8_192)
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.includes("\0") &&
      !value.includes("\\") &&
      !value.split("/").some((part) => part === "." || part === ".."),
    "A canonical absolute POSIX path is required."
  );

export const HostRuntimeManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    electronExecutable: RuntimeAbsolutePathSchema,
    guardianModule: RuntimeAbsolutePathSchema,
    nativeDirectory: RuntimeAbsolutePathSchema,
    desktopBuildRoot: RuntimeAbsolutePathSchema,
    electronVersion: z.literal("43.4.0"),
    nodePtyVersion: z.literal("1.1.0")
  })
  .strict();

export const HostReadinessRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("runtime.ready"),
    service: z.literal("autostack-host-daemon"),
    pid: z.number().int().positive(),
    origin: z.string().regex(/^http:\/\/127\.0\.0\.1:(?:[1-9]\d{0,4})$/)
  })
  .strict()
  .superRefine((value, context) => {
    const port = Number(value.origin.slice(value.origin.lastIndexOf(":") + 1));
    if (port > 65_535) context.addIssue({ code: "custom", message: "Readiness port is invalid." });
  });

export const HostParentLifecycleMessageSchema = z.discriminatedUnion("type", [
  z.object({ schemaVersion: z.literal(1), type: z.literal("quiesce") }).strict(),
  z.object({ schemaVersion: z.literal(1), type: z.literal("interrupt-and-drain") }).strict(),
  z.object({ schemaVersion: z.literal(1), type: z.literal("close") }).strict()
]);

export const HostDrainedMessageSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("drained"),
    result: RunnerDrainResultSchema
  })
  .strict();

const RuntimeInstanceIdSchema = z
  .string()
  .regex(/^runtime_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const LoopbackOriginSchema = z
  .string()
  .regex(/^http:\/\/127\.0\.0\.1:(?:[1-9]\d{0,4})$/)
  .refine((value) => Number(value.slice(value.lastIndexOf(":") + 1)) <= 65_535);

export const ControlPlaneBootstrapSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("control-plane.bootstrap"),
    instanceId: RuntimeInstanceIdSchema,
    apiTokenDigest: z.string().regex(/^[0-9a-f]{64}$/),
    dataDirectory: RuntimeAbsolutePathSchema,
    hostOrigin: LoopbackOriginSchema,
    hostToken: z.string().min(32).max(4_096),
    host: z.literal("127.0.0.1"),
    port: z.literal(0)
  })
  .strict();

export const ControlPlaneReadinessRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("runtime.ready"),
    service: z.literal("autostack-control-plane"),
    pid: z.number().int().positive(),
    origin: LoopbackOriginSchema
  })
  .strict();

export const ControlPlaneParentLifecycleMessageSchema = HostParentLifecycleMessageSchema;
export const ControlPlaneDrainedMessageSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("drained"),
    remainingReconciliationCount: z.literal(0)
  })
  .strict();

export type HostRuntimeManifest = z.infer<typeof HostRuntimeManifestSchema>;
export type HostReadinessRecord = z.infer<typeof HostReadinessRecordSchema>;
export type HostParentLifecycleMessage = z.infer<typeof HostParentLifecycleMessageSchema>;
export type HostDrainedMessage = z.infer<typeof HostDrainedMessageSchema>;
export type ControlPlaneBootstrap = z.infer<typeof ControlPlaneBootstrapSchema>;
export type ControlPlaneReadinessRecord = z.infer<typeof ControlPlaneReadinessRecordSchema>;
export type ControlPlaneParentLifecycleMessage = z.infer<
  typeof ControlPlaneParentLifecycleMessageSchema
>;
export type ControlPlaneDrainedMessage = z.infer<typeof ControlPlaneDrainedMessageSchema>;
