import { posix as posixPath } from "node:path";

import { z } from "zod";

/**
 * How an agent child is launched: an executable and an argument array, and nothing that could
 * become a command line.
 *
 * Spec §9.3 treats editing this configuration as permission to execute local code, and restricts it
 * to the workspace owner. This module is the enforcement point available at *this* layer — it can
 * bound and validate the shape, but it cannot authorize the editor. Surfaces that expose launch
 * configuration for editing owe that authorization check themselves; a schema is not a permission
 * system.
 *
 * There is deliberately no `shell` option, no command-string field, and no passthrough for extra
 * spawn options: the schema is `.strict()` so a stray `shell: true` is a validation failure rather
 * than a silently honoured request.
 */

/** Process argument lists are bounded by the OS; these are well inside every platform's limit. */
export const MAX_LAUNCH_ARGS = 256;
export const MAX_LAUNCH_ARG_BYTES = 32_768;
export const MAX_LAUNCH_ENVIRONMENT_ENTRIES = 128;
const MAX_PATH_BYTES = 4_096;

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

/**
 * An absolute path with no NUL and no whitespace, bounded in BYTES.
 *
 * Byte length rather than `.max()` on the string: a four-byte emoji is two UTF-16 code units, so a
 * character cap admits roughly twice the bytes it appears to, and every limit that actually bites
 * here — `ARG_MAX`, `PATH_MAX` — counts bytes.
 */
const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => posixPath.isAbsolute(value), "A path must be absolute.")
  .refine((value) => !value.includes("\0"), "A path must not contain a NUL byte.")
  .refine((value) => !/\s/u.test(value), "A path must not contain whitespace.")
  .refine((value) => utf8Bytes(value) <= MAX_PATH_BYTES, "A path exceeds its byte budget.");

/**
 * Mirrors `NonSecretEnvironmentEntrySchema` in `packages/contracts/src/agent.ts`, which is
 * module-private there. Same name rule, so a name this admits the contract admits too.
 *
 * These are the caller's non-secret entries only. Ambient authentication variables are copied by
 * the environment policy (D-5) and never travel through here as values.
 */
const LaunchEnvironmentEntrySchema = z
  .object({
    name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/u),
    value: z.string().max(MAX_LAUNCH_ARG_BYTES)
  })
  .strict();

export const AgentLaunchConfigSchema = z
  .object({
    executable: AbsolutePathSchema,
    args: z
      .array(
        z
          .string()
          .refine(
            (value) => utf8Bytes(value) <= MAX_LAUNCH_ARG_BYTES,
            "An argument exceeds its byte budget."
          )
      )
      .max(MAX_LAUNCH_ARGS),
    cwd: AbsolutePathSchema,
    environment: z.array(LaunchEnvironmentEntrySchema).max(MAX_LAUNCH_ENVIRONMENT_ENTRIES)
  })
  .strict();

export type AgentLaunchConfig = z.infer<typeof AgentLaunchConfigSchema>;

/** Normalized, non-empty path segments — the unit containment is compared in. */
const pathSegments = (value: string): readonly string[] =>
  posixPath
    .normalize(value)
    .split("/")
    .filter((segment) => segment.length > 0);

/**
 * Admits an **already-resolved** executable path only when it lies strictly inside an allowed root.
 *
 * Callers pass the output of `realpath`, which is the point: a symlink at a vetted location can
 * point anywhere, and only the resolved path says where the kernel will actually go.
 *
 * Containment is compared segment-wise, never by string prefix. `/opt/homebrew-evil/claude`
 * shares a textual prefix with `/opt/homebrew` while being an entirely unrelated directory, and a
 * `startsWith` test admits it — failing open, which is the expensive direction.
 *
 * The root itself is a boundary, not a candidate: a directory is not an executable, and admitting
 * it would let a caller aim the spawn at the root it was constrained to.
 */
export const admitExecutableWithinRoots = (
  resolvedExecutable: string,
  allowedRoots: readonly string[]
): string => {
  if (!posixPath.isAbsolute(resolvedExecutable) || resolvedExecutable.includes("\0")) {
    throw new TypeError("A resolved executable path must be absolute and NUL-free.");
  }

  const targetSegments = pathSegments(resolvedExecutable);

  const admitted = allowedRoots.some((root) => {
    if (!posixPath.isAbsolute(root)) return false;
    const rootSegments = pathSegments(root);
    // Strictly inside: every root segment matches, and at least one segment remains beneath it.
    if (targetSegments.length <= rootSegments.length) return false;
    return rootSegments.every((segment, index) => segment === targetSegments[index]);
  });

  if (!admitted) {
    throw new TypeError("The resolved executable lies outside every allowed root.");
  }
  return resolvedExecutable;
};
