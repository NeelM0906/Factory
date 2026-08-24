import { createHash, randomUUID } from "node:crypto";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  LocalArtifactReadRequestSchema,
  LocalCancelRequestSchema,
  LocalDisposeRequestSchema,
  LocalEventsRequestSchema,
  LocalInspectRequestSchema,
  LocalPrepareRequestSchema,
  LocalStartRequestSchema
} from "@autostack/contracts";

import type { CliExitCode, TextWriter } from "./doctor.js";
import type { AutoStackHttpClient } from "./http-client.js";

export interface LocalCliDependencies {
  readonly client: AutoStackHttpClient;
  readonly stdout: TextWriter;
  readonly stderr: TextWriter;
}

const usage = (dependencies: Pick<LocalCliDependencies, "stderr">): CliExitCode => {
  dependencies.stderr.write("Usage error. Run 'autostack --help' for supported commands.\n");
  return 1;
};

const flags = (arguments_: readonly string[]) => {
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    if (name === "--json") {
      json = true;
      continue;
    }
    const value = arguments_[index + 1];
    if (
      name === undefined ||
      !name.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    )
      throw new TypeError();
    values.set(name, value);
    index += 1;
  }
  return { values, json };
};

const required = (values: ReadonlyMap<string, string>, name: string): string => {
  const value = values.get(name);
  if (value === undefined || value === "") throw new TypeError();
  return value;
};

const writeResult = (value: unknown, json: boolean, dependencies: LocalCliDependencies): void => {
  dependencies.stdout.write(`${json ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`);
};

export async function runLocalCommand(
  arguments_: readonly string[],
  dependencies: LocalCliDependencies
): Promise<CliExitCode> {
  const command = arguments_[0];
  try {
    if (command === "inspect") {
      const parsed = flags(arguments_.slice(1));
      const response = await dependencies.client.localInspect(
        LocalInspectRequestSchema.parse({
          sourcePath: required(parsed.values, "--repo"),
          baseRef: required(parsed.values, "--base")
        })
      );
      writeResult(response, parsed.json, dependencies);
      return 0;
    }
    if (command === "prepare") {
      const parsed = flags(arguments_.slice(1));
      const key = required(parsed.values, "--idempotency-key");
      const response = await dependencies.client.localPrepare(
        LocalPrepareRequestSchema.parse({
          runId: required(parsed.values, "--run"),
          approvalId: required(parsed.values, "--approval"),
          environmentAuthorizationId: required(parsed.values, "--environment-authorization"),
          environmentId: required(parsed.values, "--environment-id"),
          sourcePath: required(parsed.values, "--repo"),
          baseRef: required(parsed.values, "--base"),
          branchSlug: required(parsed.values, "--slug")
        }),
        key
      );
      writeResult(response, parsed.json, dependencies);
      return 0;
    }
    if (command === "exec") {
      const delimiter = arguments_.indexOf("--");
      if (delimiter < 0 || delimiter === arguments_.length - 1) return usage(dependencies);
      const parsed = flags(arguments_.slice(1, delimiter));
      const executable = arguments_[delimiter + 1];
      if (executable === undefined) return usage(dependencies);
      const key = required(parsed.values, "--idempotency-key");
      const response = await dependencies.client.localStart(
        LocalStartRequestSchema.parse({
          runId: required(parsed.values, "--run"),
          approvalId: required(parsed.values, "--approval"),
          commandAuthorizationId: required(parsed.values, "--command-authorization"),
          environmentId: required(parsed.values, "--environment"),
          commandId: required(parsed.values, "--command-id"),
          command: {
            executable,
            args: arguments_.slice(delimiter + 2),
            cwd: ".",
            environment: [],
            timeoutSeconds: 600,
            terminal: { columns: 120, rows: 40 }
          }
        }),
        key
      );
      writeResult(response, parsed.json, dependencies);
      return 0;
    }
    if (command === "events") {
      const parsed = flags(arguments_.slice(1));
      const request = LocalEventsRequestSchema.parse({
        environmentId: required(parsed.values, "--environment"),
        commandId: required(parsed.values, "--command"),
        after: Number(parsed.values.get("--after") ?? "0")
      });
      for await (const item of dependencies.client.localEvents(request)) {
        if (parsed.json) dependencies.stdout.write(`${JSON.stringify(item)}\n`);
        else if (item.type === "runner.event" && item.event.type === "terminal.output")
          dependencies.stdout.write(item.event.text);
        else dependencies.stderr.write(`${item.type}\n`);
      }
      return 0;
    }
    if (command === "cancel") {
      const parsed = flags(arguments_.slice(1));
      const response = await dependencies.client.localCancel(
        LocalCancelRequestSchema.parse({
          environmentId: required(parsed.values, "--environment"),
          commandId: required(parsed.values, "--command"),
          commandAuthorizationId: required(parsed.values, "--command-authorization"),
          idempotencyKey: required(parsed.values, "--idempotency-key")
        })
      );
      writeResult(response, parsed.json, dependencies);
      return 0;
    }
    if (command === "dispose") {
      const parsed = flags(arguments_.slice(1));
      const response = await dependencies.client.localDispose(
        LocalDisposeRequestSchema.parse({
          environmentId: required(parsed.values, "--environment"),
          environmentAuthorizationId: required(parsed.values, "--environment-authorization"),
          idempotencyKey: required(parsed.values, "--idempotency-key")
        })
      );
      writeResult(response, parsed.json, dependencies);
      return 0;
    }
    if (command === "artifact") {
      const parsed = flags(arguments_.slice(1));
      await publishArtifact(
        required(parsed.values, "--artifact"),
        required(parsed.values, "--output"),
        dependencies
      );
      return 0;
    }
    return usage(dependencies);
  } catch {
    dependencies.stderr.write("Local command failed.\n");
    return 3;
  }
}

const publishArtifact = async (
  artifactId: string,
  output: string,
  dependencies: LocalCliDependencies
): Promise<void> => {
  try {
    await lstat(output);
    throw new TypeError("Output already exists.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(dirname(output), `.${basename(output)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let published = false;
  try {
    const digest = createHash("sha256");
    let offset = 0;
    let expected:
      | { readonly digest: string; readonly byteSize: number; readonly artifactId: string }
      | undefined;
    while (true) {
      const response = await dependencies.client.localArtifact(
        LocalArtifactReadRequestSchema.parse({ artifactId, offset, length: 1_048_576 })
      );
      if (expected === undefined) expected = response.artifact;
      else if (JSON.stringify(expected) !== JSON.stringify(response.artifact))
        throw new TypeError();
      const bytes = Buffer.from(response.bytes, "base64");
      await handle.write(bytes, 0, bytes.byteLength, offset);
      digest.update(bytes);
      offset = response.nextOffset;
      if (response.done) break;
    }
    if (
      expected === undefined ||
      offset !== expected.byteSize ||
      digest.digest("hex") !== expected.digest
    )
      throw new TypeError();
    await handle.sync();
    await handle.close();
    await rename(temporary, output);
    published = true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!published) await unlink(temporary).catch(() => undefined);
  }
};
