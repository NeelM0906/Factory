import { containsSensitiveMaterial } from "@autostack/contracts";
import { describe, expect, it } from "vitest";

import {
  assertScanClean,
  assertWorkspaceOutsideCheckout,
  buildClaudeArgv,
  buildCodexArgv,
  buildCodexHandshake,
  buildFixtureDocument,
  CLAUDE_PERMISSION_TOOL,
  CLAUDE_SESSION_IDS,
  createTranscriptNormalizer,
  deriveMalformedFixture,
  findSensitiveLocations,
  INVALID_MODEL_NAME,
  isEvidenceBearingFrame,
  normalizeFixtureDocument,
  parseArguments,
  providerStability,
  SCENARIO_PLAN,
  TRANSCRIPT_FRAME_KINDS,
  TRANSCRIPT_PLACEHOLDERS as RECORDER_PLACEHOLDERS,
  TRANSCRIPT_SCENARIOS as RECORDER_SCENARIOS,
  UsageError
} from "../scripts/record-transcripts.mjs";
import {
  TRANSCRIPT_PLACEHOLDERS,
  TRANSCRIPT_SCENARIOS,
  TranscriptFixtureSchema,
  TranscriptFrameSchema
} from "../src/testing/transcript-format.js";
import type { TranscriptFrame } from "../src/testing/transcript-format.js";

/**
 * These tests cover the recorder's pure surface only. Nothing here spawns a provider CLI: a suite
 * that needed `claude` or `codex` on PATH would be a live-network test wearing a unit test's badge,
 * and it would stop being evidence the moment CI ran it.
 */

const RECORDED_AT = "2026-08-27T12:00:00.000Z";
const CREDENTIAL = `sk-ant-api03-${"A".repeat(80)}`;

const validArgs = ["--provider", "claude", "--scenario", "completes", "--out", "/tmp/fixtures"];

const sampleFrames: readonly TranscriptFrame[] = [
  { kind: "emit", value: { type: "system", subtype: "init" } },
  { kind: "emitStderr", text: "warning: something happened" },
  { kind: "awaitStdin", match: { type: "user" } },
  { kind: "exit", code: 0, signal: null }
];

const fixture = (overrides: {
  readonly provider?: "claude" | "codex";
  readonly frames?: readonly TranscriptFrame[];
  readonly argv?: readonly string[];
}) =>
  buildFixtureDocument({
    provider: overrides.provider ?? "claude",
    scenario: "completes",
    version: "2.1.228 (Claude Code)",
    recordedAt: RECORDED_AT,
    argv: overrides.argv ?? ["claude", "-p", "Print the contents of README.md and stop."],
    frames: overrides.frames ?? sampleFrames,
    notes: "recorded by the unit test"
  });

describe("the format mirror", () => {
  it("keeps the placeholders identical to transcript-format.ts", () => {
    expect({ ...RECORDER_PLACEHOLDERS }).toStrictEqual({ ...TRANSCRIPT_PLACEHOLDERS });
  });

  it("keeps the scenario list identical to transcript-format.ts", () => {
    expect([...RECORDER_SCENARIOS]).toStrictEqual([...TRANSCRIPT_SCENARIOS]);
  });

  it("keeps the frame kind names identical to the frame schema", () => {
    expect(TRANSCRIPT_FRAME_KINDS).toHaveLength(TranscriptFrameSchema.options.length);
    for (const frame of sampleFrames) {
      expect(TRANSCRIPT_FRAME_KINDS).toContain(frame.kind);
      expect(TranscriptFrameSchema.safeParse(frame).success).toBe(true);
    }
    expect(TranscriptFrameSchema.safeParse({ kind: "emitStdout", value: 1 }).success).toBe(false);
  });
});

describe("parseArguments", () => {
  it("accepts the documented triple", () => {
    expect(parseArguments(validArgs)).toStrictEqual({
      help: false,
      provider: "claude",
      scenario: "completes",
      out: "/tmp/fixtures"
    });
  });

  it("reports help without recording", () => {
    expect(parseArguments(["--help"])).toStrictEqual({ help: true });
    expect(parseArguments([...validArgs, "-h"])).toStrictEqual({ help: true });
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArguments([...validArgs, "--force"])).toThrow(UsageError);
    expect(() => parseArguments([...validArgs, "--force"])).toThrow(/Unknown argument/);
  });

  it("rejects a stray positional argument", () => {
    expect(() => parseArguments(["claude", ...validArgs])).toThrow(/Unknown argument/);
  });

  it("rejects a repeated flag", () => {
    expect(() => parseArguments([...validArgs, "--provider", "codex"])).toThrow(/Repeated flag/);
  });

  it("rejects a flag with no value", () => {
    expect(() => parseArguments(["--provider", "claude", "--scenario", "--out"])).toThrow(
      /--scenario needs a value/
    );
    expect(() => parseArguments([...validArgs.slice(0, 4), "--out"])).toThrow(
      /--out needs a value/
    );
  });

  it("rejects a missing flag", () => {
    expect(() => parseArguments(["--provider", "claude", "--scenario", "completes"])).toThrow(
      /Missing required flag: --out/
    );
  });

  it("rejects an empty --out", () => {
    expect(() =>
      parseArguments(["--provider", "claude", "--scenario", "completes", "--out", " "])
    ).toThrow(/must not be empty/);
  });

  it("rejects acp, which is authored rather than recorded", () => {
    expect(() =>
      parseArguments(["--provider", "acp", "--scenario", "completes", "--out", "/tmp/x"])
    ).toThrow(/authored against the protocol, not recorded/);
  });

  it("rejects an unknown scenario", () => {
    expect(() =>
      parseArguments(["--provider", "codex", "--scenario", "explodes", "--out", "/tmp/x"])
    ).toThrow(/Unknown scenario/);
  });

  it("always carries the usage text so the operator can act on the failure", () => {
    expect(() => parseArguments([])).toThrow(/--provider <claude\|codex>/);
  });
});

describe("Claude argv", () => {
  it("builds the completes invocation exactly", () => {
    expect(
      buildClaudeArgv({ scenario: "completes", sessionId: CLAUDE_SESSION_IDS.completes })
    ).toStrictEqual([
      "-p",
      SCENARIO_PLAN.completes.objective,
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      CLAUDE_SESSION_IDS.completes,
      "--setting-sources",
      "project"
    ]);
  });

  it("suppresses the operator's global hooks on every scenario", () => {
    for (const scenario of ["completes", "pauses", "fails", "interrupted"] as const) {
      const args = buildClaudeArgv({
        scenario,
        sessionId: CLAUDE_SESSION_IDS[scenario]
      });
      expect(args[args.indexOf("--setting-sources") + 1]).toBe("project");
    }
  });

  it("moves the objective onto stdin for the streaming scenario", () => {
    const args = buildClaudeArgv({ scenario: "pauses", sessionId: CLAUDE_SESSION_IDS.pauses });
    expect(args).toContain("--input-format");
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(args).not.toContain(SCENARIO_PLAN.pauses.objective);
  });

  it("provokes the failure with an invalid model name on argv", () => {
    const args = buildClaudeArgv({ scenario: "fails", sessionId: CLAUDE_SESSION_IDS.fails });
    expect(args[args.indexOf("--model") + 1]).toBe(INVALID_MODEL_NAME);
  });

  it("wires the permission channel and refuses to build it half-configured", () => {
    const args = buildClaudeArgv({
      scenario: "requests_permission",
      sessionId: CLAUDE_SESSION_IDS.requests_permission,
      mcpConfigPath: "/tmp/agent-workspace/mcp-permission.json"
    });
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/tmp/agent-workspace/mcp-permission.json");
    expect(args[args.indexOf("--permission-prompt-tool") + 1]).toBe(CLAUDE_PERMISSION_TOOL);

    expect(() =>
      buildClaudeArgv({
        scenario: "requests_permission",
        sessionId: CLAUDE_SESSION_IDS.requests_permission
      })
    ).toThrow(/generated MCP config path/);
  });

  it("refuses to spawn anything for the derived scenario", () => {
    expect(() => buildClaudeArgv({ scenario: "malformed", sessionId: "x" })).toThrow(
      /derived, not spawned/
    );
  });

  it("pins provider session identity rather than discovering it", () => {
    expect(() => buildClaudeArgv({ scenario: "completes", sessionId: "" })).toThrow(
      /session id is required/
    );
  });
});

describe("Codex argv and handshake", () => {
  it("silences the operator's own MCP servers on every scenario", () => {
    for (const scenario of [
      "completes",
      "pauses",
      "requests_permission",
      "fails",
      "interrupted"
    ] as const) {
      const args = buildCodexArgv({ scenario });
      expect(args.slice(0, 3)).toStrictEqual(["app-server", "-c", "mcp_servers={}"]);
    }
  });

  it("provokes the failure with an invalid model name on argv", () => {
    expect(buildCodexArgv({ scenario: "fails" })).toStrictEqual([
      "app-server",
      "-c",
      "mcp_servers={}",
      "-c",
      `model="${INVALID_MODEL_NAME}"`
    ]);
  });

  it("drives initialize, initialized, thread/start, turn/start in that order", () => {
    const steps = buildCodexHandshake({ scenario: "completes", workspace: "/tmp/agent-workspace" });
    expect(steps.map((step) => step.message["method"])).toStrictEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start"
    ]);
    for (const step of steps) {
      // A fixture player blocks on a structural subset, never on an id the client mints.
      expect(Object.keys(step.match)).toStrictEqual(["method"]);
    }
  });

  it("asks for approvals only in the permission scenario", () => {
    const gated = buildCodexHandshake({
      scenario: "requests_permission",
      workspace: "/tmp/agent-workspace"
    });
    expect(gated[2]?.message["params"]).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "read-only",
      cwd: "/tmp/agent-workspace"
    });

    const plain = buildCodexHandshake({ scenario: "completes", workspace: "/tmp/agent-workspace" });
    expect(plain[2]?.message["params"]).toMatchObject({ approvalPolicy: "never" });
  });

  it("requires an absolute workspace", () => {
    expect(() => buildCodexHandshake({ scenario: "completes", workspace: "relative" })).toThrow(
      /absolute workspace path/
    );
  });
});

describe("isEvidenceBearingFrame", () => {
  it("ignores handshake bookkeeping and recognizes real evidence", () => {
    expect(isEvidenceBearingFrame("claude", { type: "system", subtype: "init" })).toBe(false);
    expect(isEvidenceBearingFrame("claude", { type: "rate_limit_event" })).toBe(false);
    expect(isEvidenceBearingFrame("claude", { type: "assistant" })).toBe(true);
    expect(isEvidenceBearingFrame("claude", { type: "user" })).toBe(true);

    expect(isEvidenceBearingFrame("codex", { method: "thread/started" })).toBe(false);
    expect(isEvidenceBearingFrame("codex", { method: "item/completed" })).toBe(true);
    expect(isEvidenceBearingFrame("codex", "not an object")).toBe(false);
  });
});

describe("normalization", () => {
  const normalize = createTranscriptNormalizer({
    home: ["/Users/operator", "/System/Volumes/Data/Users/operator"],
    workspace: ["/var/folders/qz/T/autostack-transcript-ab12", "/tmp/autostack-transcript-ab12"],
    username: "operator"
  });

  it("rewrites machine-specific values inside frames, including object keys", () => {
    const frames: readonly TranscriptFrame[] = [
      {
        kind: "emit",
        value: {
          cwd: "/var/folders/qz/T/autostack-transcript-ab12",
          nested: { settings: "/Users/operator/.claude/settings.json" },
          list: ["hello operator", 7, null]
        }
      },
      { kind: "emitStderr", text: "failed under /tmp/autostack-transcript-ab12/README.md" },
      { kind: "awaitStdin", match: { "/Users/operator": "key" } }
    ];

    expect(normalize(frames)).toStrictEqual([
      {
        kind: "emit",
        value: {
          cwd: TRANSCRIPT_PLACEHOLDERS.workspace,
          nested: { settings: `${TRANSCRIPT_PLACEHOLDERS.home}/.claude/settings.json` },
          list: [`hello ${TRANSCRIPT_PLACEHOLDERS.username}`, 7, null]
        }
      },
      {
        kind: "emitStderr",
        text: `failed under ${TRANSCRIPT_PLACEHOLDERS.workspace}/README.md`
      },
      { kind: "awaitStdin", match: { [TRANSCRIPT_PLACEHOLDERS.home]: "key" } }
    ]);
  });

  it("rewrites the recorded argv too, not only the frames", () => {
    const document = normalizeFixtureDocument(
      fixture({
        argv: [
          "claude",
          "--mcp-config",
          "/tmp/autostack-transcript-ab12/mcp-permission.json",
          "--add-dir",
          "/Users/operator/work"
        ]
      }),
      normalize
    );
    expect(document.provenance.argv).toStrictEqual([
      "claude",
      "--mcp-config",
      `${TRANSCRIPT_PLACEHOLDERS.workspace}/mcp-permission.json`,
      "--add-dir",
      `${TRANSCRIPT_PLACEHOLDERS.home}/work`
    ]);
  });

  it("substitutes in a single pass, so a placeholder is never rewritten again", () => {
    // A user literally named `home` would turn `/home/agent` into `/agent/agent` under a chain of
    // replaceAll calls. One pass cannot, because the emitted placeholder is never rescanned.
    const hostile = createTranscriptNormalizer({ home: "/Users/home", username: "home" });
    expect(hostile("/Users/home/notes")).toBe(`${TRANSCRIPT_PLACEHOLDERS.home}/notes`);
  });

  it("skips an identity replacement rather than churning the document", () => {
    const identity = createTranscriptNormalizer({ username: TRANSCRIPT_PLACEHOLDERS.username });
    expect(identity("agent wrote agent")).toBe("agent wrote agent");
  });
});

describe("the scan gate", () => {
  it("passes a normalized document", () => {
    expect(findSensitiveLocations(fixture({}), containsSensitiveMaterial)).toStrictEqual([]);
    expect(() => assertScanClean(fixture({}), containsSensitiveMaterial)).not.toThrow();
  });

  it("names the frame a credential survived in", () => {
    const document = fixture({
      frames: [
        { kind: "emit", value: { type: "system", subtype: "init" } },
        { kind: "emitStderr", text: `auth failed for ${CREDENTIAL}` },
        { kind: "exit", code: 1, signal: null }
      ]
    });
    expect(findSensitiveLocations(document, containsSensitiveMaterial)).toContain(
      "$.frames[1].text"
    );
  });

  it("names the argv entry a credential survived in", () => {
    const document = fixture({ argv: ["claude", "--api-key", CREDENTIAL] });
    expect(findSensitiveLocations(document, containsSensitiveMaterial)).toContain(
      "$.provenance.argv[2]"
    );
  });

  it("fails loudly and tells the operator to re-record rather than edit", () => {
    const document = fixture({ argv: ["claude", CREDENTIAL] });
    let thrown: unknown;
    try {
      assertScanClean(document, containsSensitiveMaterial, {
        provider: "claude",
        scenario: "completes"
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain("Credential scan failed for claude-completes");
    expect(message).toContain("containsSensitiveMaterial tripped at");
    expect(message).toContain("$.provenance.argv[1]");
    expect(message).toContain("The frames are NOT edited to make this pass.");
    expect(message).toContain("Re-record with the offending variable unset");
  });
});

describe("fixture assembly", () => {
  it("produces a document the real schema accepts", () => {
    const parsed = TranscriptFixtureSchema.safeParse(fixture({}));
    expect(parsed.success).toBe(true);
  });

  it("records full provenance", () => {
    expect(fixture({}).provenance).toStrictEqual({
      source: "recorded",
      cli: "claude",
      version: "2.1.228 (Claude Code)",
      recordedAt: RECORDED_AT,
      argv: ["claude", "-p", "Print the contents of README.md and stop."],
      stability: "stable",
      notes: "recorded by the unit test"
    });
  });

  it("marks codex app-server experimental and everything else stable", () => {
    expect(providerStability("codex")).toBe("experimental");
    expect(providerStability("claude")).toBe("stable");
    expect(fixture({ provider: "codex" }).provenance.stability).toBe("experimental");
  });

  it("refuses to write an empty transcript", () => {
    expect(() => fixture({ frames: [] })).toThrow(/Refusing to write an empty/);
  });

  it("rejects a provider it cannot record", () => {
    expect(() =>
      buildFixtureDocument({
        // The declaration keeps this honest at compile time; the guard keeps it honest at run time.
        provider: "acp" as "claude",
        scenario: "completes",
        version: "1",
        recordedAt: RECORDED_AT,
        argv: [],
        frames: sampleFrames
      })
    ).toThrow(/Unknown provider/);
  });
});

describe("deriveMalformedFixture", () => {
  const source = fixture({ provider: "codex" });
  const derived = deriveMalformedFixture(source, RECORDED_AT);

  it("corrupts exactly one frame and leaves the rest untouched", () => {
    expect(derived.frames).toHaveLength(source.frames.length);
    const changed = derived.frames.filter(
      (frame, index) => JSON.stringify(frame) !== JSON.stringify(source.frames[index])
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ kind: "emit" });
    expect(typeof (changed[0] as { value: unknown }).value).toBe("string");
  });

  it("truncates the frame's own JSON text, so the corruption is deterministic", () => {
    const original = JSON.stringify(
      source.frames[0]?.kind === "emit" ? source.frames[0].value : {}
    );
    const corrupted = derived.frames[0];
    expect(corrupted).toStrictEqual({
      kind: "emit",
      value: original.slice(0, Math.floor(original.length / 2))
    });
  });

  it("stops claiming to be a recording and says where it came from", () => {
    expect(derived.provenance.source).toBe("authored");
    expect(derived.provenance.cli).toBe("codex");
    expect(derived.provenance.stability).toBe("experimental");
    expect(derived.provenance.notes).toContain("Derived from the recorded codex-completes");
    expect(derived.scenario).toBe("malformed");
  });

  it("still validates against the real schema", () => {
    expect(TranscriptFixtureSchema.safeParse(derived).success).toBe(true);
  });

  it("refuses to derive from a transcript with nothing to corrupt", () => {
    expect(() =>
      deriveMalformedFixture(
        fixture({ frames: [{ kind: "exit", code: 0, signal: null }] }),
        RECORDED_AT
      )
    ).toThrow(/no object-valued `emit` frame/);
  });
});

describe("assertWorkspaceOutsideCheckout", () => {
  it("accepts a temp directory", () => {
    expect(() =>
      assertWorkspaceOutsideCheckout("/private/tmp/autostack-transcript-ab12", "/Users/x/autostack")
    ).not.toThrow();
  });

  it("refuses a workspace inside the checkout", () => {
    expect(() =>
      assertWorkspaceOutsideCheckout("/Users/x/autostack/tmp/work", "/Users/x/autostack")
    ).toThrow(/inside the AutoStack checkout/);
  });

  it("refuses the checkout itself", () => {
    expect(() =>
      assertWorkspaceOutsideCheckout("/Users/x/autostack", "/Users/x/autostack")
    ).toThrow(/inside the AutoStack checkout/);
  });

  it("refuses a workspace that contains the checkout", () => {
    expect(() => assertWorkspaceOutsideCheckout("/Users/x", "/Users/x/autostack")).toThrow(
      /checkout .* is inside it/
    );
  });

  it("refuses a relative path outright", () => {
    expect(() => assertWorkspaceOutsideCheckout("work", "/Users/x/autostack")).toThrow(
      /must be an absolute path/
    );
  });

  it("is not fooled by a sibling directory sharing a prefix", () => {
    expect(() =>
      assertWorkspaceOutsideCheckout("/Users/x/autostack-scratch", "/Users/x/autostack")
    ).not.toThrow();
  });
});
