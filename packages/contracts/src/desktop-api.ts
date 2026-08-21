import { z } from "zod";

import {
  ArtifactIdSchema,
  CommandIdSchema,
  EnvironmentIdSchema,
  RepositoryCapabilityIdSchema
} from "./ids.js";
import {
  ReadArtifactChunkRequestSchema,
  ReadArtifactChunkResponseSchema,
  RunnerStreamEventSchema
} from "./runner.js";

const RepositoryCapabilitySchema = z
  .object({
    id: RepositoryCapabilityIdSchema,
    label: z.string().trim().min(1).max(240),
    expiresAt: z.iso.datetime()
  })
  .strict();
export const DesktopRepositoryPickerRequestSchema = z.object({}).strict();
export const DesktopRepositoryPickerResponseSchema = z
  .object({ repository: RepositoryCapabilitySchema.nullable() })
  .strict();
export const DesktopCommandStreamRequestSchema = z
  .object({
    environmentId: EnvironmentIdSchema,
    commandId: CommandIdSchema,
    after: z.number().int().nonnegative().default(0)
  })
  .strict();
export const DesktopRuntimeStatusSchema = z
  .object({
    status: z.enum(["starting", "ready", "degraded", "stopped"]),
    message: z.string().max(1_000).optional()
  })
  .strict();
export const DesktopArtifactReadRequestSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    offset: z.number().int().nonnegative(),
    length: z.number().int().min(1).max(1_048_576)
  })
  .strict();
export const DesktopApiOperationMapSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("runtime.status"),
      request: z.object({}).strict(),
      response: DesktopRuntimeStatusSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("repository.pick"),
      request: DesktopRepositoryPickerRequestSchema,
      response: DesktopRepositoryPickerResponseSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("artifact.read"),
      request: DesktopArtifactReadRequestSchema,
      response: ReadArtifactChunkResponseSchema
    })
    .strict()
]);

export interface DesktopApiOperationMap {
  readonly "runtime.status": {
    readonly request: z.infer<typeof DesktopRuntimeStatusSchema>;
    readonly response: z.infer<typeof DesktopRuntimeStatusSchema>;
  };
  readonly "repository.pick": {
    readonly request: z.infer<typeof DesktopRepositoryPickerRequestSchema>;
    readonly response: z.infer<typeof DesktopRepositoryPickerResponseSchema>;
  };
  readonly "artifact.read": {
    readonly request: z.infer<typeof DesktopArtifactReadRequestSchema>;
    readonly response: z.infer<typeof ReadArtifactChunkResponseSchema>;
  };
}

export type RepositoryCapability = z.infer<typeof RepositoryCapabilitySchema>;
export type DesktopCommandStreamRequest = z.infer<typeof DesktopCommandStreamRequestSchema>;
export type DesktopRuntimeStatus = z.infer<typeof DesktopRuntimeStatusSchema>;
export type DesktopArtifactReadRequest = z.infer<typeof DesktopArtifactReadRequestSchema>;
export type DesktopRunnerEvent = z.infer<typeof RunnerStreamEventSchema>;
export type DesktopReadArtifactChunkRequest = z.infer<typeof ReadArtifactChunkRequestSchema>;
