#!/usr/bin/env node
/**
 * Re-record one provider transcript fixture.
 *
 * This script is checked in so that a re-record is reproducible rather than a fresh act of
 * archaeology. Every scenario carries a fixed objective text and a deterministic provocation, taken
 * from the plan's Task 1 Step 1 table, so two recordings a year apart differ only in what the
 * provider CLI actually changed.
 *
 *   node record-transcripts.mjs --provider <claude|codex> --scenario <scenario> --out <dir>
 *
 * Design constraints this file honours, and which a future edit must keep:
 *
 * - Every process invocation is `executable` + `args` with `shell: false`. Never a shell string.
 * - The recording runs inside a disposable temp repository that is asserted to live outside the
 *   AutoStack checkout, and is deleted in a `finally`.
 * - Machine-specific values are normalized to `TRANSCRIPT_PLACEHOLDERS` in BOTH the frames and the
 *   recorded argv, and only then is the document scanned with `containsSensitiveMaterial`. A fixture
 *   that still trips the scan is re-recorded, never edited.
 *
 * SOURCE OF TRUTH: `../src/testing/transcript-format.ts` owns the fixture format. The placeholder
 * values and frame `kind` names are mirrored below so that the pure, unit-testable exports in this
 * file need no module load at all; `test/record-transcripts.test.ts` pins the mirrors equal to the
 * real ones, so drift fails the suite rather than the next recording. The schema itself is loaded at
 * run time (see `loadTranscriptFormat`) and every emitted document is parsed through it.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------------------------
// Mirrored constants. Source of truth: ../src/testing/transcript-format.ts
// ---------------------------------------------------------------------------------------------

export const TRANSCRIPT_PLACEHOLDERS = Object.freeze({
  home: "/home/agent",
  workspace: "/tmp/agent-workspace",
  username: "agent"
});

export const TRANSCRIPT_FRAME_KINDS = Object.freeze(["emit", "emitStderr", "awaitStdin", "exit"]);

export const TRANSCRIPT_SCENARIOS = Object.freeze([
  "completes",
  "pauses",
  "requests_permission",
  "fails",
  "interrupted",
  "malformed"
]);

/** `acp` is authored, not recorded: no ACP agent is installed. This script records the two CLIs. */
export const RECORDABLE_PROVIDERS = Object.freeze(["claude", "codex"]);

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

/** A malformed invocation. Carries the usage text so `main` need not reassemble it. */
export class UsageError extends Error {
  constructor(message) {
    super(`${message}\n\n${USAGE}`);
    this.name = "UsageError";
  }
}

export const USAGE = [
  "Usage:",
  "  node record-transcripts.mjs --provider <claude|codex> --scenario <scenario> --out <dir>",
  "",
  `Scenarios: ${TRANSCRIPT_SCENARIOS.join(" | ")}`,
  "",
  "Every flag is required and may be given at most once. `--out` is created if missing.",
  "The `malformed` scenario spawns nothing: it derives from `<out>/<provider>-completes.json`,",
  "which must already exist."
].join("\n");

const FLAGS = Object.freeze({
  "--provider": "provider",
  "--scenario": "scenario",
  "--out": "out"
});

/**
 * Parses the recorder's own argv (the arguments after the script path).
 *
 * Returns `{ help: true }` for `--help`/`-h`, otherwise the validated triple. Anything else throws
 * `UsageError`; the caller exits non-zero.
 */
export const parseArguments = (argv) => {
  if (!Array.isArray(argv)) throw new UsageError("Arguments must be an array.");
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };

  const seen = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const key = FLAGS[token];
    if (key === undefined) throw new UsageError(`Unknown argument: ${JSON.stringify(token)}`);
    if (seen.has(key)) throw new UsageError(`Repeated flag: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || FLAGS[value] !== undefined) {
      throw new UsageError(`Flag ${token} needs a value.`);
    }
    seen.set(key, value);
    index += 1;
  }

  for (const [flag, key] of Object.entries(FLAGS)) {
    if (!seen.has(key)) throw new UsageError(`Missing required flag: ${flag}`);
  }

  const provider = seen.get("provider");
  const scenario = seen.get("scenario");
  const out = seen.get("out");

  if (!RECORDABLE_PROVIDERS.includes(provider)) {
    throw new UsageError(
      `Unknown provider: ${JSON.stringify(provider)}. ` +
        `Recordable providers are ${RECORDABLE_PROVIDERS.join(", ")}. ` +
        "The `acp` transcripts are authored against the protocol, not recorded."
    );
  }
  if (!TRANSCRIPT_SCENARIOS.includes(scenario)) {
    throw new UsageError(`Unknown scenario: ${JSON.stringify(scenario)}.`);
  }
  if (out.trim().length === 0) throw new UsageError("`--out` must not be empty.");

  return { help: false, provider, scenario, out };
};

// ---------------------------------------------------------------------------------------------
// The scenario table (plan Task 1, Step 1)
// ---------------------------------------------------------------------------------------------

/** The single invalid model name every `fails` recording passes on argv. */
export const INVALID_MODEL_NAME = "autostack-invalid-model-does-not-exist";

/** The permission-prompt tool Claude Code is told to call, named `mcp__<server>__<tool>`. */
export const CLAUDE_PERMISSION_TOOL = "mcp__perm__approve";

/**
 * Fixed session identifiers, one per Claude scenario. Deterministic rather than `randomUUID` so a
 * re-record reproduces the same shape; obviously synthetic so nobody mistakes one for a real
 * session. Each is a well-formed v4 UUID because `--session-id` rejects anything else.
 */
export const CLAUDE_SESSION_IDS = Object.freeze({
  completes: "11111111-1111-4111-8111-111111111111",
  pauses: "22222222-2222-4222-8222-222222222222",
  requests_permission: "33333333-3333-4333-8333-333333333333",
  fails: "44444444-4444-4444-8444-444444444444",
  interrupted: "55555555-5555-4555-8555-555555555555"
});

export const SCENARIO_PLAN = Object.freeze({
  completes: Object.freeze({
    objective: "Print the contents of README.md and stop.",
    provocation: "none -- runs to completion",
    streamingInput: false
  }),
  pauses: Object.freeze({
    objective: "Wait for further instructions before doing anything.",
    provocation: "none -- the CLI blocks on input",
    streamingInput: true
  }),
  requests_permission: Object.freeze({
    objective: "Create a file named notes.txt containing the word hello.",
    provocation: "permission channel wired so the write must be approved",
    streamingInput: false
  }),
  fails: Object.freeze({
    objective: "Print the contents of README.md and stop.",
    provocation: "invalid model name passed on argv",
    streamingInput: false
  }),
  interrupted: Object.freeze({
    objective: "Print the contents of README.md and stop.",
    provocation: "SIGKILL the child after the first evidence-bearing frame",
    streamingInput: false
  }),
  malformed: Object.freeze({
    objective: null,
    provocation: "derived -- copy the completes transcript and corrupt one frame",
    streamingInput: false
  })
});

export const scenarioPlan = (scenario) => {
  const plan = SCENARIO_PLAN[scenario];
  if (plan === undefined) throw new UsageError(`Unknown scenario: ${JSON.stringify(scenario)}.`);
  return plan;
};

// ---------------------------------------------------------------------------------------------
// Provider argv
// ---------------------------------------------------------------------------------------------

/**
 * Claude Code argv for one scenario.
 *
 * `--setting-sources project` is not optional decoration: without it the operator's global hooks
 * inject `hook_started`/`hook_response` frames and the fixture becomes machine-shaped.
 */
export const buildClaudeArgv = ({ scenario, sessionId, mcpConfigPath }) => {
  const plan = scenarioPlan(scenario);
  if (scenario === "malformed") {
    throw new UsageError("The `malformed` scenario is derived, not spawned.");
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new UsageError("A session id is required so provider session identity is pinned.");
  }

  const args = ["-p"];
  // In streaming-input mode the objective travels as a stream-json user message on stdin instead,
  // so that the process stays alive and genuinely blocks rather than merely finishing slowly.
  if (!plan.streamingInput) args.push(plan.objective);
  args.push(
    "--output-format",
    "stream-json",
    "--verbose",
    "--session-id",
    sessionId,
    "--setting-sources",
    "project"
  );
  if (plan.streamingInput) args.push("--input-format", "stream-json");
  if (scenario === "fails") args.push("--model", INVALID_MODEL_NAME);
  if (scenario === "requests_permission") {
    if (typeof mcpConfigPath !== "string" || mcpConfigPath.length === 0) {
      throw new UsageError("The permission scenario needs a generated MCP config path.");
    }
    args.push(
      "--mcp-config",
      mcpConfigPath,
      "--strict-mcp-config",
      "--permission-prompt-tool",
      CLAUDE_PERMISSION_TOOL
    );
  }
  return args;
};

/**
 * Codex argv for one scenario.
 *
 * `-c mcp_servers={}` is the analogue of Claude's `--setting-sources project`: without it the
 * operator's own MCP servers load into the session and fill the transcript with
 * `mcpServer/startupStatus/updated` notifications and stderr authentication failures.
 */
export const buildCodexArgv = ({ scenario }) => {
  scenarioPlan(scenario);
  if (scenario === "malformed") {
    throw new UsageError("The `malformed` scenario is derived, not spawned.");
  }
  const args = ["app-server", "-c", "mcp_servers={}"];
  if (scenario === "fails") args.push("-c", `model="${INVALID_MODEL_NAME}"`);
  return args;
};

/** Substituted with the thread id `thread/start` returns, which is minted by the server. */
export const CODEX_THREAD_ID_TOKEN = "${threadId}";

export const CODEX_CLIENT_INFO = Object.freeze({
  name: "autostack-transcript-recorder",
  title: "AutoStack transcript recorder",
  version: "0.1.0"
});

/**
 * The JSON-RPC conversation the recorder drives over Codex's stdio: `initialize`, the `initialized`
 * notification, `thread/start`, `turn/start`. Each step carries the structural subset a fixture
 * player should block on, which never pins an id the client mints.
 */
export const buildCodexHandshake = ({ scenario, workspace }) => {
  const plan = scenarioPlan(scenario);
  if (scenario === "malformed") {
    throw new UsageError("The `malformed` scenario is derived, not spawned.");
  }
  if (typeof workspace !== "string" || !isAbsolute(workspace)) {
    throw new UsageError("Codex `thread/start` needs an absolute workspace path.");
  }
  const gated = scenario === "requests_permission";
  return [
    {
      message: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { ...CODEX_CLIENT_INFO } }
      },
      match: { method: "initialize" }
    },
    { message: { jsonrpc: "2.0", method: "initialized" }, match: { method: "initialized" } },
    {
      message: {
        jsonrpc: "2.0",
        id: 2,
        method: "thread/start",
        params: {
          cwd: workspace,
          approvalPolicy: gated ? "on-request" : "never",
          sandbox: gated ? "read-only" : "workspace-write"
        }
      },
      match: { method: "thread/start" }
    },
    {
      message: {
        jsonrpc: "2.0",
        id: 3,
        method: "turn/start",
        params: {
          threadId: CODEX_THREAD_ID_TOKEN,
          input: [{ type: "text", text: plan.objective }]
        }
      },
      match: { method: "turn/start" }
    }
  ];
};

/** The stream-json user message Claude reads from stdin in streaming-input mode. */
export const buildClaudeStdinMessage = (objective) => ({
  type: "user",
  message: { role: "user", content: [{ type: "text", text: objective }] }
});

/**
 * The trailing `awaitStdin` match a `pauses` transcript ends on: the fixture is blocked waiting for
 * the client's next frame, which is the whole point of the scenario.
 */
export const PAUSE_STDIN_MATCH = Object.freeze({
  claude: Object.freeze({ type: "user" }),
  codex: Object.freeze({ jsonrpc: "2.0" })
});

/** Codex notification methods that carry session evidence rather than handshake bookkeeping. */
const CODEX_EVIDENCE_METHODS = new Set([
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/reasoning/delta",
  "thread/tokenUsage/updated"
]);

/**
 * Whether a decoded stdout frame is the first thing worth interrupting after.
 *
 * `interrupted` SIGKILLs the child once real evidence has been produced; killing during the
 * handshake would record a transcript indistinguishable from a launch failure.
 */
export const isEvidenceBearingFrame = (provider, value) => {
  if (typeof value !== "object" || value === null) return false;
  if (provider === "claude") {
    const type = value.type;
    return type === "assistant" || type === "user";
  }
  if (provider === "codex") {
    return typeof value.method === "string" && CODEX_EVIDENCE_METHODS.has(value.method);
  }
  return false;
};

// ---------------------------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------------------------

const asList = (value) => {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).filter(
    (entry) => typeof entry === "string" && entry.length > 0
  );
};

/**
 * Replaces every occurrence in one pass, longest needle first.
 *
 * A sequential `replaceAll` chain would let a later needle chew through an earlier substitution's
 * output (a user literally named `home` would turn `/home/agent` into `/agent/agent`). One pass
 * cannot, because the emitted placeholder is never rescanned.
 */
const applyReplacements = (text, replacements) => {
  if (replacements.length === 0) return text;
  let out = "";
  let index = 0;
  while (index < text.length) {
    let matched = false;
    for (const replacement of replacements) {
      if (text.startsWith(replacement.from, index)) {
        out += replacement.to;
        index += replacement.from.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += text[index];
      index += 1;
    }
  }
  return out;
};

/**
 * Builds the normalizer applied to frames and argv alike.
 *
 * `home` and `workspace` accept several spellings each, because a path arrives from the CLI either
 * as given or resolved (`/tmp/...` versus `/private/tmp/...` on macOS) and both must be caught.
 */
export const createTranscriptNormalizer = ({ home, workspace, username }) => {
  const replacements = [
    ...asList(workspace).map((from) => ({ from, to: TRANSCRIPT_PLACEHOLDERS.workspace })),
    ...asList(home).map((from) => ({ from, to: TRANSCRIPT_PLACEHOLDERS.home })),
    ...asList(username).map((from) => ({ from, to: TRANSCRIPT_PLACEHOLDERS.username }))
  ]
    .filter((replacement) => replacement.from !== replacement.to)
    .sort((left, right) => right.from.length - left.from.length);

  const normalize = (value) => {
    if (typeof value === "string") return applyReplacements(value, replacements);
    if (Array.isArray(value)) return value.map(normalize);
    if (typeof value === "object" && value !== null) {
      const out = {};
      for (const [key, entry] of Object.entries(value)) {
        out[applyReplacements(key, replacements)] = normalize(entry);
      }
      return out;
    }
    return value;
  };

  return normalize;
};

/**
 * Normalizes the whole fixture document.
 *
 * Everything is normalized, not just the frames and argv: a placeholder cannot appear inside an
 * ISO timestamp or a schema enum, so a blanket pass is strictly safer than an allowlist of fields
 * somebody will forget to extend.
 */
export const normalizeFixtureDocument = (document, normalize) => normalize(document);

// ---------------------------------------------------------------------------------------------
// The scan gate
// ---------------------------------------------------------------------------------------------

const walkStrings = (value, path, visit) => {
  if (typeof value === "string") {
    visit(path, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkStrings(entry, `${path}[${index}]`, visit));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      visit(`${path}.<key>`, key);
      walkStrings(entry, `${path}.${key}`, visit);
    }
  }
};

/**
 * Every location in the normalized document that trips the credential scan.
 *
 * Each string is scanned individually so the failure names a place the operator can act on, and the
 * whole serialization is scanned once more as `<document>` to catch anything that only shows up
 * across a field boundary.
 */
export const findSensitiveLocations = (document, containsSensitiveMaterial) => {
  const locations = [];
  walkStrings(document, "$", (path, value) => {
    if (containsSensitiveMaterial(value)) locations.push(path);
  });
  if (containsSensitiveMaterial(JSON.stringify(document) ?? "")) locations.push("<document>");
  return locations;
};

/**
 * The gate. Normalization has already run; if the document still trips the scan the answer is a
 * re-record with the offending variable unset, never an edit to the frames.
 */
export const assertScanClean = (document, containsSensitiveMaterial, context = {}) => {
  const locations = findSensitiveLocations(document, containsSensitiveMaterial);
  if (locations.length === 0) return;
  const subject = [context.provider, context.scenario].filter(Boolean).join("-") || "fixture";
  throw new Error(
    [
      `Credential scan failed for ${subject}: containsSensitiveMaterial tripped at ` +
        `${locations.join(", ")}.`,
      "",
      "The frames are NOT edited to make this pass. Re-record with the offending variable unset,",
      "for example:",
      "",
      `  env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY node record-transcripts.mjs --provider ` +
        `${context.provider ?? "<provider>"} --scenario ${context.scenario ?? "<scenario>"} ` +
        `--out <dir>`,
      "",
      "If the material is a path or username the normalizer missed, extend",
      "createTranscriptNormalizer -- do not hand-edit the fixture."
    ].join("\n")
  );
};

// ---------------------------------------------------------------------------------------------
// Fixture assembly
// ---------------------------------------------------------------------------------------------

const MAX_FRAMES = 2_000;
const MAX_NOTES = 8_000;

const boundNotes = (notes) => {
  if (typeof notes !== "string" || notes.length === 0) return undefined;
  if (notes.length <= MAX_NOTES) return notes;
  const marker = "\n[truncated by record-transcripts.mjs]";
  return `${notes.slice(0, MAX_NOTES - marker.length)}${marker}`;
};

/** `codex app-server` is marked `[experimental]` by the CLI itself; that travels with the fixture. */
export const providerStability = (provider) => (provider === "codex" ? "experimental" : "stable");

/** Assembles the un-normalized document. Normalization and the scan run after this, in that order. */
export const buildFixtureDocument = ({
  provider,
  scenario,
  version,
  recordedAt,
  argv,
  frames,
  notes
}) => {
  if (!RECORDABLE_PROVIDERS.includes(provider)) {
    throw new UsageError(`Unknown provider: ${JSON.stringify(provider)}.`);
  }
  scenarioPlan(scenario);
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error(`Refusing to write an empty ${provider}-${scenario} transcript.`);
  }
  if (frames.length > MAX_FRAMES) {
    throw new Error(
      `Recorded ${frames.length} frames for ${provider}-${scenario}; the format allows ` +
        `${MAX_FRAMES}. Shorten the objective or raise the bound in transcript-format.ts.`
    );
  }

  const document = {
    provenance: {
      source: "recorded",
      cli: provider,
      version,
      recordedAt,
      argv,
      stability: providerStability(provider)
    },
    scenario,
    frames
  };
  const bounded = boundNotes(notes);
  if (bounded !== undefined) document.provenance.notes = bounded;
  return document;
};

/**
 * Derives the `malformed` fixture from a recorded `completes` transcript.
 *
 * The corruption is deterministic: the last object-valued `emit` before the terminal frame keeps its
 * position but loses its shape, becoming the first half of its own JSON text. A fixture player
 * writes that as a bare JSON string, which is exactly the shape an adapter must classify as a
 * failure instead of crashing on.
 *
 * `source` becomes `"authored"`. The frames are no longer a faithful recording of anything the CLI
 * emitted, and calling them `"recorded"` would be the fixture lying about its own provenance; the
 * notes name the transcript it came from and the corruption applied.
 */
export const deriveMalformedFixture = (completesDocument, recordedAt) => {
  const frames = completesDocument.frames;
  if (!Array.isArray(frames)) throw new Error("The source transcript has no frames array.");

  const index = frames.reduce(
    (found, frame, at) =>
      frame.kind === "emit" && typeof frame.value === "object" && frame.value !== null ? at : found,
    -1
  );
  if (index < 0) {
    throw new Error(
      "The source transcript has no object-valued `emit` frame to corrupt. Re-record `completes` " +
        "before deriving `malformed`."
    );
  }

  const original = JSON.stringify(frames[index].value);
  const truncated = original.slice(0, Math.max(1, Math.floor(original.length / 2)));
  const corrupted = frames.map((frame, at) =>
    at === index ? { kind: "emit", value: truncated } : frame
  );

  return {
    provenance: {
      ...completesDocument.provenance,
      source: "authored",
      recordedAt,
      notes: boundNotes(
        [
          `Derived from the recorded ${completesDocument.provenance.cli}-completes transcript by ` +
            `truncating frame ${index}.`,
          `That frame's value was replaced with the first ${truncated.length} characters of its ` +
            "own JSON text, so a fixture player emits a bare JSON string where the protocol " +
            "requires a frame object.",
          "This is the sixth scenario the charter requires and no conformance subject replays it: " +
            "malformed provider output must be a classified failure, not a crash.",
          completesDocument.provenance.notes ?? ""
        ]
          .filter((line) => line.length > 0)
          .join("\n\n")
      )
    },
    scenario: "malformed",
    frames: corrupted
  };
};

// ---------------------------------------------------------------------------------------------
// Workspace guard
// ---------------------------------------------------------------------------------------------

const withTrailingSeparator = (path) => (path.endsWith(sep) ? path : `${path}${sep}`);

/**
 * Refuses to record inside the AutoStack checkout.
 *
 * A recording runs a coding agent with a real objective in its working directory. If that directory
 * were the checkout, the "disposable" workspace would be the repository, and the `finally` that
 * deletes it would delete the repository.
 */
export const assertWorkspaceOutsideCheckout = (workspace, checkoutRoot) => {
  if (typeof workspace !== "string" || !isAbsolute(workspace)) {
    throw new Error(`The temp workspace must be an absolute path, got ${String(workspace)}.`);
  }
  if (typeof checkoutRoot !== "string" || !isAbsolute(checkoutRoot)) {
    throw new Error(`The checkout root must be an absolute path, got ${String(checkoutRoot)}.`);
  }
  const workspacePath = withTrailingSeparator(resolve(workspace));
  const checkoutPath = withTrailingSeparator(resolve(checkoutRoot));
  if (workspacePath === checkoutPath || workspacePath.startsWith(checkoutPath)) {
    throw new Error(
      `Refusing to record in ${workspace}: it is inside the AutoStack checkout ${checkoutRoot}. ` +
        "Recordings run a real agent and the workspace is deleted afterwards."
    );
  }
  if (checkoutPath.startsWith(workspacePath)) {
    throw new Error(
      `Refusing to record in ${workspace}: the AutoStack checkout ${checkoutRoot} is inside it.`
    );
  }
};

/** Walks up from `startDir` to the directory holding `pnpm-workspace.yaml`. */
const findCheckoutRoot = (startDir) => {
  let current = resolve(startDir);
  for (;;) {
    try {
      readFileSync(join(current, "pnpm-workspace.yaml"));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        throw new Error(`Could not find the AutoStack checkout root above ${startDir}.`);
      }
      current = parent;
    }
  }
};

// ---------------------------------------------------------------------------------------------
// Run-time module loading
// ---------------------------------------------------------------------------------------------

/**
 * Loads `containsSensitiveMaterial` from `@autostack/contracts`.
 *
 * The package's `exports` map points at TypeScript source, so the plain package import only works
 * once contracts ships built JavaScript. Until then the fallback resolves the package entry through
 * its own export map and imports the sibling `secret-safety.ts` directly -- Node's native type
 * stripping (available on every version this repo's `engines` allows) handles it, because that
 * module's only import is `zod`. Either way this is the real implementation, never a local
 * re-implementation of the credential rules.
 */
const loadContainsSensitiveMaterial = async () => {
  try {
    const contracts = await import("@autostack/contracts");
    if (typeof contracts.containsSensitiveMaterial === "function") {
      return contracts.containsSensitiveMaterial;
    }
  } catch {
    // Fall through to the direct-module import below.
  }
  const entry = import.meta.resolve("@autostack/contracts");
  const module = await import(new URL("./secret-safety.ts", entry).href);
  if (typeof module.containsSensitiveMaterial !== "function") {
    throw new Error("@autostack/contracts does not export containsSensitiveMaterial.");
  }
  return module.containsSensitiveMaterial;
};

/** Loads the fixture schema so every emitted document is parsed by the real contract. */
const loadTranscriptFormat = async () =>
  import(new URL("../src/testing/transcript-format.ts", import.meta.url).href);

// ---------------------------------------------------------------------------------------------
// The disposable workspace
// ---------------------------------------------------------------------------------------------

const README_TEXT = [
  "# transcript-fixture-workspace",
  "",
  "A disposable repository created by record-transcripts.mjs. It exists for the length of one",
  "recording and is deleted afterwards.",
  ""
].join("\n");

/** The D-5 allowlist: names are copied, values are never read into anything this script inspects. */
const ENVIRONMENT_ALLOWLIST = Object.freeze(["HOME", "PATH", "USER", "SHELL", "LANG", "TMPDIR"]);

const PROVIDER_AUTH_VARIABLES = Object.freeze({
  claude: Object.freeze([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "XDG_CONFIG_HOME"
  ]),
  codex: Object.freeze(["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME", "XDG_CONFIG_HOME"])
});

const buildSpawnEnvironment = (provider) => {
  const names = [...ENVIRONMENT_ALLOWLIST, ...(PROVIDER_AUTH_VARIABLES[provider] ?? [])];
  const environment = {};
  for (const name of names) {
    if (Object.hasOwn(process.env, name)) environment[name] = process.env[name];
  }
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("LC_")) environment[name] = process.env[name];
  }
  return environment;
};

const runCommand = (executable, args, options) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, { ...options, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(`${executable} ${args.join(" ")} exited ${code}: ${stderr}`));
    });
  });

/**
 * `mkdtemp` + `git init` + one commit.
 *
 * `mkdtempSync` is `mktemp -d` without a subprocess. Git runs with its global and system config
 * neutralized and an explicit identity so the seed commit is not shaped by the operator's machine.
 */
const createDisposableRepository = async (checkoutRoot) => {
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), "autostack-transcript-"));
  assertWorkspaceOutsideCheckout(workspace, checkoutRoot);
  assertWorkspaceOutsideCheckout(realpathSync(workspace), checkoutRoot);

  const gitEnvironment = {
    ...buildSpawnEnvironment("git"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null"
  };
  const git = (args) => runCommand("git", args, { cwd: workspace, env: gitEnvironment });

  await git(["init", "--quiet", "--initial-branch=main"]);
  writeFileSync(join(workspace, "README.md"), README_TEXT, "utf8");
  await git(["add", "README.md"]);
  await git([
    "-c",
    "user.name=AutoStack transcript recorder",
    "-c",
    "user.email=recorder@autostack.invalid",
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    "chore: seed the disposable transcript workspace"
  ]);

  return workspace;
};

/**
 * Writes the minimal raw-JSON-RPC MCP stdio server Claude Code spawns for the permission scenario,
 * plus the `--mcp-config` document pointing at it.
 *
 * The server denies every request. A denial is the deterministic provocation: it proves the decision
 * genuinely gates the side effect (the file is never created) and leaves the workspace untouched, so
 * a re-record cannot drift on whatever the model chose to write.
 */
const writePermissionServer = (workspace) => {
  const serverPath = join(workspace, "permission-server.mjs");
  const logPath = join(workspace, "permission-mcp.log");
  const configPath = join(workspace, "mcp-permission.json");

  writeFileSync(
    serverPath,
    [
      "// Generated by record-transcripts.mjs. Minimal MCP stdio server, raw JSON-RPC, no SDK.",
      'import { appendFileSync } from "node:fs";',
      "",
      `const LOG = ${JSON.stringify(logPath)};`,
      "const log = (line) => appendFileSync(LOG, `${line}\\n`);",
      "const send = (message) => { const text = JSON.stringify(message); log(`SEND ${text}`);" +
        " process.stdout.write(`${text}\\n`); };",
      "",
      "const TOOL = {",
      '  name: "approve",',
      '  description: "Decide whether a tool call may proceed.",',
      "  inputSchema: {",
      '    type: "object",',
      "    properties: {",
      '      tool_name: { type: "string" },',
      '      input: { type: "object" },',
      '      tool_use_id: { type: "string" }',
      "    },",
      '    required: ["tool_name", "input"]',
      "  }",
      "};",
      "",
      'let buffer = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => {',
      "  buffer += chunk;",
      "  let index;",
      '  while ((index = buffer.indexOf("\\n")) >= 0) {',
      "    const line = buffer.slice(0, index);",
      "    buffer = buffer.slice(index + 1);",
      "    if (!line.trim()) continue;",
      "    log(`RECV ${line}`);",
      "    let message;",
      "    try { message = JSON.parse(line); } catch { continue; }",
      '    if (message.method === "initialize") {',
      "      send({",
      '        jsonrpc: "2.0",',
      "        id: message.id,",
      "        result: {",
      '          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",',
      "          capabilities: { tools: {} },",
      '          serverInfo: { name: "autostack-transcript-permission-probe", version: "0.1.0" }',
      "        }",
      "      });",
      '    } else if (message.method === "tools/list") {',
      '      send({ jsonrpc: "2.0", id: message.id, result: { tools: [TOOL] } });',
      '    } else if (message.method === "tools/call") {',
      "      send({",
      '        jsonrpc: "2.0",',
      "        id: message.id,",
      "        result: {",
      "          content: [",
      "            {",
      '              type: "text",',
      "              text: JSON.stringify({",
      '                behavior: "deny",',
      '                message: "The transcript recorder denies every request by design."',
      "              })",
      "            }",
      "          ]",
      "        }",
      "      });",
      "    } else if (message.id !== undefined) {",
      '      send({ jsonrpc: "2.0", id: message.id, result: {} });',
      "    }",
      "  }",
      "});",
      ""
    ].join("\n"),
    "utf8"
  );

  // The recon's working config used `command`/`args` with no `type` discriminator; keep that shape.
  writeFileSync(
    configPath,
    `${JSON.stringify({
      mcpServers: { perm: { command: process.execPath, args: [serverPath] } }
    })}\n`,
    "utf8"
  );

  return { configPath, logPath };
};

// ---------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------

const MAX_STDERR_FRAME = 64_000;
const SCENARIO_TIMEOUT_MS = 180_000;
const IDLE_MS = 5_000;

const chunkText = (text, size) => {
  const chunks = [];
  for (let index = 0; index < text.length; index += size)
    chunks.push(text.slice(index, index + size));
  return chunks;
};

/**
 * Captures one child's stdout frames and stderr lines in arrival order, and records every stdin
 * write as the `awaitStdin` frame a fixture player blocks on.
 */
class ChildRecorder {
  constructor(child) {
    this.child = child;
    this.frames = [];
    this.lastActivityAt = Date.now();
    this.waiters = [];
    this.stdoutBuffer = "";
    this.stderrBuffer = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      this.stdoutBuffer = this.consumeLines(this.stdoutBuffer + chunk, (line) =>
        this.pushStdout(line)
      );
    });
    child.stderr.on("data", (chunk) => {
      this.stderrBuffer = this.consumeLines(this.stderrBuffer + chunk, (line) =>
        this.pushStderr(line)
      );
    });

    this.exited = new Promise((resolvePromise) => {
      child.on("close", (code, signal) => {
        this.flush();
        resolvePromise({ code: code ?? null, signal: signal ?? null });
      });
    });
  }

  consumeLines(buffer, onLine) {
    let rest = buffer;
    let index;
    while ((index = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, index);
      rest = rest.slice(index + 1);
      if (line.trim().length > 0) onLine(line);
    }
    return rest;
  }

  pushStdout(line) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      // Both CLIs speak one JSON document per stdout line. A line that does not parse is real
      // provider output and is recorded verbatim rather than dropped.
      value = line;
    }
    this.record({ kind: "emit", value });
  }

  pushStderr(line) {
    for (const chunk of chunkText(line, MAX_STDERR_FRAME)) {
      this.record({ kind: "emitStderr", text: chunk });
    }
  }

  record(frame) {
    this.frames.push(frame);
    this.lastActivityAt = Date.now();
    for (const waiter of [...this.waiters]) waiter(frame);
  }

  flush() {
    if (this.stdoutBuffer.trim().length > 0) this.pushStdout(this.stdoutBuffer);
    if (this.stderrBuffer.trim().length > 0) this.pushStderr(this.stderrBuffer);
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
  }

  send(message, match) {
    this.record({ kind: "awaitStdin", match });
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  appendAwaitStdin(match) {
    this.record({ kind: "awaitStdin", match });
  }

  appendExit({ code, signal }) {
    this.record({ kind: "exit", code, signal });
  }

  /** Resolves with the first recorded frame satisfying `predicate`, or rejects on timeout/exit. */
  waitForFrame(predicate, timeoutMs = SCENARIO_TIMEOUT_MS, label = "a matching frame") {
    const existing = this.frames.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        cleanup();
        rejectPromise(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`));
      }, timeoutMs);
      const waiter = (frame) => {
        if (!predicate(frame)) return;
        cleanup();
        resolvePromise(frame);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((entry) => entry !== waiter);
      };
      this.waiters.push(waiter);
      this.exited.then(() => {
        const late = this.frames.find(predicate);
        cleanup();
        if (late !== undefined) resolvePromise(late);
        else rejectPromise(new Error(`The child exited before producing ${label}.`));
      });
    });
  }

  /** Resolves once the child has produced at least one frame and then gone quiet for `idleMs`. */
  async waitForIdle(idleMs = IDLE_MS, timeoutMs = SCENARIO_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const quietFor = Date.now() - this.lastActivityAt;
      if (this.frames.length > 0 && quietFor >= idleMs) return;
      if (Date.now() > deadline) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for the child to go idle.`);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }

  kill(signal) {
    try {
      this.child.kill(signal);
    } catch {
      // The child is already gone; the exit frame is recorded from `close` either way.
    }
  }

  closeStdin() {
    try {
      this.child.stdin.end();
    } catch {
      // Already closed.
    }
  }
}

const spawnRecorder = (executable, args, { cwd, env }) => {
  const child = spawn(executable, args, {
    cwd,
    env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });
  return new ChildRecorder(child);
};

const readCliVersion = async (executable, env) => {
  const { stdout } = await runCommand(executable, ["--version"], { env });
  const version = stdout.trim().split("\n")[0]?.trim() ?? "";
  if (version.length === 0) throw new Error(`${executable} --version produced no output.`);
  return version;
};

const driveClaude = async (recorder, { scenario, plan }) => {
  if (plan.streamingInput) {
    recorder.send(buildClaudeStdinMessage(plan.objective), PAUSE_STDIN_MATCH.claude);
  }

  if (scenario === "pauses") {
    await recorder.waitForIdle();
    recorder.flush();
    // The transcript ends blocked on input rather than on an exit: that is the scenario.
    recorder.appendAwaitStdin(PAUSE_STDIN_MATCH.claude);
    recorder.kill("SIGKILL");
    await recorder.exited;
    return;
  }

  if (scenario === "interrupted") {
    await recorder.waitForFrame(
      (frame) => frame.kind === "emit" && isEvidenceBearingFrame("claude", frame.value),
      SCENARIO_TIMEOUT_MS,
      "the first evidence-bearing frame"
    );
    recorder.kill("SIGKILL");
    recorder.appendExit(await recorder.exited);
    return;
  }

  recorder.closeStdin();
  recorder.appendExit(await recorder.exited);
};

const driveCodex = async (recorder, { scenario, plan, workspace }) => {
  let threadId;
  for (const step of buildCodexHandshake({ scenario, workspace })) {
    const message = JSON.parse(
      JSON.stringify(step.message).replaceAll(
        JSON.stringify(CODEX_THREAD_ID_TOKEN),
        JSON.stringify(threadId ?? CODEX_THREAD_ID_TOKEN)
      )
    );
    if (message.method === "turn/start" && message.params.threadId === CODEX_THREAD_ID_TOKEN) {
      throw new Error("`thread/start` never returned a thread id.");
    }
    recorder.send(message, step.match);
    if (message.id === undefined) continue;

    const response = await recorder.waitForFrame(
      (frame) =>
        frame.kind === "emit" &&
        typeof frame.value === "object" &&
        frame.value !== null &&
        frame.value.id === message.id,
      SCENARIO_TIMEOUT_MS,
      `the response to ${message.method}`
    );
    if (message.method === "thread/start") {
      threadId = response.value?.result?.thread?.id;
    }
    if (scenario === "interrupted" && message.method === "turn/start") {
      await recorder.waitForFrame(
        (frame) => frame.kind === "emit" && isEvidenceBearingFrame("codex", frame.value),
        SCENARIO_TIMEOUT_MS,
        "the first evidence-bearing frame"
      );
      recorder.kill("SIGKILL");
      recorder.appendExit(await recorder.exited);
      return;
    }
  }

  if (scenario === "requests_permission") {
    // Stop at the ask, without answering it. D-3's ordering is exactly what this transcript has to
    // preserve: the approval request arrives, and nothing executes behind it.
    await recorder.waitForFrame(
      (frame) =>
        frame.kind === "emit" &&
        typeof frame.value === "object" &&
        frame.value !== null &&
        typeof frame.value.method === "string" &&
        frame.value.method.endsWith("/requestApproval"),
      SCENARIO_TIMEOUT_MS,
      "an approval request"
    );
    recorder.flush();
    recorder.appendAwaitStdin(PAUSE_STDIN_MATCH.codex);
    recorder.kill("SIGKILL");
    await recorder.exited;
    return;
  }

  if (scenario === "pauses") {
    await recorder.waitForIdle();
    recorder.flush();
    recorder.appendAwaitStdin(PAUSE_STDIN_MATCH.codex);
    recorder.kill("SIGKILL");
    await recorder.exited;
    return;
  }

  // `completes` and `fails`: let the turn settle, then close stdin so the app-server shuts down.
  await recorder
    .waitForFrame(
      (frame) =>
        frame.kind === "emit" &&
        typeof frame.value === "object" &&
        frame.value !== null &&
        (frame.value.method === "turn/completed" || frame.value.method === "error"),
      SCENARIO_TIMEOUT_MS,
      "the turn to end"
    )
    .catch((error) => {
      if (scenario !== "fails") throw error;
      // A `fails` recording is allowed to die before any turn boundary; the exit frame carries it.
    });
  recorder.closeStdin();
  recorder.appendExit(await recorder.exited);
  void plan;
};

const buildNotes = ({ provider, scenario, plan, extra }) =>
  [
    `Objective: ${plan.objective ?? "(derived)"}`,
    `Provocation: ${plan.provocation}`,
    provider === "claude"
      ? "`--setting-sources project` suppresses the operator's global hooks, which otherwise inject " +
        "hook_started/hook_response frames and make the fixture machine-shaped."
      : "`-c mcp_servers={}` silences the operator's own MCP servers, which otherwise fill the " +
        "transcript with mcpServer/startupStatus/updated notifications and stderr auth failures.",
    provider === "codex"
      ? "`codex app-server` is marked [experimental] by the CLI; provenance.stability records it."
      : "",
    scenario === "pauses"
      ? "The transcript ends on an awaitStdin frame rather than an exit: the session is alive and " +
        "blocked on input, which is what the scenario asserts."
      : "",
    ...(extra ?? [])
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");

const recordProvider = async ({ provider, scenario, workspace }) => {
  const plan = scenarioPlan(scenario);
  const environment = buildSpawnEnvironment(provider);
  const executable = provider === "claude" ? "claude" : "codex";
  const version = await readCliVersion(executable, environment);
  const extraNotes = [];

  let args;
  let permissionLogPath;
  if (provider === "claude") {
    let mcpConfigPath;
    if (scenario === "requests_permission") {
      const generated = writePermissionServer(workspace);
      mcpConfigPath = generated.configPath;
      permissionLogPath = generated.logPath;
    }
    args = buildClaudeArgv({
      scenario,
      sessionId: CLAUDE_SESSION_IDS[scenario],
      mcpConfigPath
    });
  } else {
    args = buildCodexArgv({ scenario });
  }

  const recorder = spawnRecorder(executable, args, { cwd: workspace, env: environment });
  try {
    if (provider === "claude") await driveClaude(recorder, { scenario, plan });
    else await driveCodex(recorder, { scenario, plan, workspace });
  } finally {
    recorder.kill("SIGKILL");
  }
  recorder.flush();

  if (permissionLogPath !== undefined) {
    // Claude Code spawns the permission MCP server itself, so the round trip never appears on the
    // CLI's stdout. The transcript format has one channel; the ask is preserved verbatim in the
    // provenance notes rather than smuggled into the frames as if it had been on stdout.
    let log = "";
    try {
      log = readFileSync(permissionLogPath, "utf8");
    } catch {
      log = "(no permission MCP traffic was recorded)";
    }
    extraNotes.push(
      "Permission channel: --permission-prompt-tool " +
        `${CLAUDE_PERMISSION_TOOL} over a generated --mcp-config with --strict-mcp-config. The ` +
        "generated server denies every request, so the gated side effect is never performed. The " +
        "MCP round trip, which is off the CLI's stdout entirely, follows verbatim:",
      log.trim()
    );
  }

  return {
    version,
    argv: [basename(executable), ...args],
    frames: recorder.frames,
    notes: buildNotes({ provider, scenario, plan, extra: extraNotes })
  };
};

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

const writeFixture = (outDir, provider, scenario, document) => {
  mkdirSync(outDir, { recursive: true });
  const target = join(outDir, `${provider}-${scenario}.json`);
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return target;
};

export const main = async (argv) => {
  const parsed = parseArguments(argv);
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const { provider, scenario, out } = parsed;
  const outDir = resolve(out);
  const checkoutRoot = findCheckoutRoot(dirname(fileURLToPath(import.meta.url)));
  const [containsSensitiveMaterial, format] = await Promise.all([
    loadContainsSensitiveMaterial(),
    loadTranscriptFormat()
  ]);
  const recordedAt = new Date().toISOString();

  let document;
  if (scenario === "malformed") {
    const sourcePath = join(outDir, `${provider}-completes.json`);
    let source;
    try {
      source = JSON.parse(readFileSync(sourcePath, "utf8"));
    } catch (error) {
      throw new Error(
        `The malformed scenario derives from ${sourcePath}, which could not be read ` +
          `(${error instanceof Error ? error.message : String(error)}). Record \`completes\` first.`
      );
    }
    // The source fixture was already normalized when it was written, so this document needs no
    // second pass; it is still scanned, because the gate runs on every document that is written.
    document = deriveMalformedFixture(source, recordedAt);
  } else {
    const workspace = await createDisposableRepository(checkoutRoot);
    try {
      const recorded = await recordProvider({ provider, scenario, workspace });
      const normalize = createTranscriptNormalizer({
        home: [homedir(), realpathSync(homedir())],
        workspace: [workspace, realpathSync(workspace)],
        username: userInfo().username
      });
      document = normalizeFixtureDocument(
        buildFixtureDocument({ provider, scenario, recordedAt, ...recorded }),
        normalize
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  assertScanClean(document, containsSensitiveMaterial, { provider, scenario });
  const validated = format.parseTranscriptFixture(document);
  const target = writeFixture(outDir, provider, scenario, validated);
  process.stdout.write(`Wrote ${target} (${validated.frames.length} frames).\n`);
  return 0;
};

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}
