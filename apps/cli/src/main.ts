import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { type CliExitCode, runDoctor, type TextWriter } from "./doctor.js";
import { AutoStackHttpClient } from "./http-client.js";
import { runLocalCommand } from "./local.js";

const VERSION = "0.1.0";
const DEFAULT_URL = "http://127.0.0.1:4318";
const HELP = `AutoStack ${VERSION}

Usage:
  autostack doctor [--url http://127.0.0.1:4318] [--json]
  autostack local inspect --repo <path> --base <ref> [--json]
  autostack local prepare --run <id> --approval <id> --environment-authorization <id> --environment-id <id> --repo <path> --base <ref> --slug <slug> --idempotency-key <key> [--json]
  autostack local exec --run <id> --approval <id> --command-authorization <id> --environment <id> --command-id <id> --idempotency-key <key> -- <executable> [args...]
  autostack local events --environment <id> --command <id> --after <sequence> [--json]
  autostack local artifact --artifact <id> --output <explicit-path>
  autostack local cancel --environment <id> --command <id> --command-authorization <id> --idempotency-key <key>
  autostack local dispose --environment <id> --environment-authorization <id> --idempotency-key <key>
  autostack --help
  autostack --version
`;

export interface CliDependencies {
  readonly fetch: typeof globalThis.fetch;
  readonly stdout: TextWriter;
  readonly stderr: TextWriter;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

const usageError = (stderr: TextWriter): CliExitCode => {
  stderr.write("Usage error. Run 'autostack --help' for supported commands.\n");
  return 1;
};

const validatedBaseUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    if (!new Set(["http:", "https:"]).has(url.protocol)) return undefined;
    if (url.username !== "" || url.password !== "") return undefined;
    const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname);
    if (url.protocol === "http:" && !loopback) return undefined;
    return url.href.replace(/\/$/, "");
  } catch {
    return undefined;
  }
};

const parseCliArguments = (arguments_: readonly string[]) =>
  parseArgs({
    args: [...arguments_],
    allowPositionals: true,
    strict: true,
    options: {
      url: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false }
    }
  });

export async function runCli(
  arguments_: readonly string[],
  dependencies: CliDependencies
): Promise<CliExitCode> {
  if (arguments_[0] === "local") {
    const baseUrl = validatedBaseUrl(dependencies.environment.AUTOSTACK_URL ?? DEFAULT_URL);
    const token = dependencies.environment.AUTOSTACK_LOCAL_API_TOKEN;
    if (baseUrl === undefined || token === undefined || token.length === 0)
      return usageError(dependencies.stderr);
    return runLocalCommand(arguments_.slice(1), {
      client: new AutoStackHttpClient({ baseUrl, token, fetch: dependencies.fetch }),
      stdout: dependencies.stdout,
      stderr: dependencies.stderr
    });
  }
  let parsed: ReturnType<typeof parseCliArguments>;
  try {
    parsed = parseCliArguments(arguments_);
  } catch {
    return usageError(dependencies.stderr);
  }

  if (parsed.values.help) {
    dependencies.stdout.write(HELP);
    return 0;
  }
  if (parsed.values.version) {
    dependencies.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "doctor") {
    return usageError(dependencies.stderr);
  }

  const baseUrl = validatedBaseUrl(
    parsed.values.url ?? dependencies.environment.AUTOSTACK_URL ?? DEFAULT_URL
  );
  const environmentToken = dependencies.environment.AUTOSTACK_LOCAL_API_TOKEN;
  const token = environmentToken;
  if (baseUrl === undefined || token === undefined || token.length === 0) {
    return usageError(dependencies.stderr);
  }
  return runDoctor({ baseUrl, token, json: parsed.values.json ?? false }, dependencies);
}

const isEntrypoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  void runCli(process.argv.slice(2), {
    fetch: globalThis.fetch,
    stdout: process.stdout,
    stderr: process.stderr,
    environment: process.env
  }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
