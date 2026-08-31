import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { containsSensitiveMaterial } from "@autostack/contracts";

import {
  parseTranscriptFixture,
  TRANSCRIPT_PROVIDERS,
  TRANSCRIPT_SCENARIOS,
  type TranscriptFixture,
  type TranscriptFrame,
  type TranscriptProvider,
  type TranscriptScenario
} from "../src/testing/index.js";

/**
 * The guard that keeps the checked-in transcripts honest as they are edited later.
 *
 * Every later task in this stream replays these files, so a fixture that drifts out of the binding
 * semantics would not fail here — it would fail three packages downstream as a mysteriously wrong
 * adapter. This suite loads every fixture across all three adapter packages and asserts the
 * properties the decisions actually turn on, rather than trusting a reader to notice.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

const PACKAGE_FOR_PROVIDER: Readonly<Record<TranscriptProvider, string>> = {
  claude: "agent-claude",
  codex: "agent-codex",
  acp: "agent-acp"
};

interface LoadedFixture {
  readonly provider: TranscriptProvider;
  readonly scenario: TranscriptScenario;
  readonly fileName: string;
  readonly filePath: string;
  readonly text: string;
  readonly fixture: TranscriptFixture;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readAt = (value: unknown, ...path: readonly string[]): unknown => {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
};

/** `<provider>-<scenario>[-<variant>].json`, where scenarios use `_` and never `-`. */
const parseFileName = (
  fileName: string
): { readonly provider: string; readonly scenario: string; readonly variant: string | null } => {
  const base = fileName.replace(/\.json$/u, "");
  const [provider, scenario, ...rest] = base.split("-");
  return {
    provider: provider ?? "",
    scenario: scenario ?? "",
    variant: rest.length > 0 ? rest.join("-") : null
  };
};

const loadFixtures = (): readonly LoadedFixture[] => {
  const loaded: LoadedFixture[] = [];
  for (const provider of TRANSCRIPT_PROVIDERS) {
    const directory = join(
      HERE,
      "..",
      "..",
      PACKAGE_FOR_PROVIDER[provider],
      "test",
      "fixtures",
      "transcripts"
    );
    const fileNames = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const fileName of fileNames) {
      const filePath = join(directory, fileName);
      const text = readFileSync(filePath, "utf8");
      const fixture = parseTranscriptFixture(JSON.parse(text));
      loaded.push({
        provider,
        scenario: fixture.scenario,
        fileName,
        filePath,
        text,
        fixture
      });
    }
  }
  return loaded;
};

const FIXTURES = loadFixtures();

const forProvider = (provider: TranscriptProvider): readonly LoadedFixture[] =>
  FIXTURES.filter((entry) => entry.provider === provider);

const forScenario = (
  provider: TranscriptProvider,
  scenario: TranscriptScenario
): readonly LoadedFixture[] => forProvider(provider).filter((entry) => entry.scenario === scenario);

const emitted = (frame: TranscriptFrame): unknown =>
  frame.kind === "emit" ? frame.value : undefined;

/**
 * A provider ERROR SHAPE, per D-2: a JSON-RPC `error` response, a Claude `result` with `is_error`,
 * or a Codex `ErrorNotification`. A non-zero exit code is deliberately not one of these.
 */
const isProviderErrorShape = (provider: TranscriptProvider, frame: TranscriptFrame): boolean => {
  const value = emitted(frame);
  if (!isRecord(value)) return false;
  switch (provider) {
    case "claude":
      return value["type"] === "result" && value["is_error"] === true;
    case "codex":
      return value["method"] === "error";
    case "acp":
      return value["id"] !== undefined && isRecord(value["error"]);
  }
};

/** The frame that asks the operator to approve a gated call. */
const isApprovalRequest = (provider: TranscriptProvider, frame: TranscriptFrame): boolean => {
  const value = emitted(frame);
  if (!isRecord(value)) return false;
  switch (provider) {
    case "claude":
      // Claude Code asks through the MCP permission-prompt tool it spawns itself.
      return (
        value["method"] === "tools/call" && typeof readAt(value, "params", "name") === "string"
      );
    case "codex":
      return typeof value["method"] === "string" && value["method"].endsWith("/requestApproval");
    case "acp":
      return value["method"] === "session/request_permission";
  }
};

const CODEX_GATED_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall"
]);

/**
 * A frame the mapper would turn into a `tool_call` or a `file_change` — the events D-3 forbids
 * before the decision.
 */
/**
 * A frame the adapter would turn into an evidence-bearing event — content, not protocol.
 *
 * D-2 hinges on this distinction: signal death *after evidence* is `interrupted` (the partial
 * evidence must be preserved), while signal death *before any* evidence is `failed`, because there
 * is nothing partial to preserve. A guard that merely counts `emit` frames cannot tell those apart:
 * a transcript whose only emits are `initialize`/`thread/start` handshake responses would satisfy
 * it while describing a session that never produced anything.
 *
 * Named defect this rejects: a handshake-only `interrupted` transcript.
 */
const isEvidenceBearing = (provider: TranscriptProvider, frame: TranscriptFrame): boolean => {
  const value = emitted(frame);
  if (!isRecord(value)) return false;
  switch (provider) {
    case "claude":
      return value["type"] === "assistant" || value["type"] === "user";
    case "codex":
      return typeof value["method"] === "string" && value["method"].startsWith("item/");
    case "acp":
      return value["method"] === "session/update";
  }
};

const claudeContentHas = (value: Record<string, unknown>, blockType: string): boolean => {
  const content = readAt(value, "message", "content");
  if (!Array.isArray(content)) return false;
  return content.some((block) => isRecord(block) && block["type"] === blockType);
};

/**
 * The provider ANNOUNCING that it intends to make a gated call.
 *
 * Kept separate from the side effect below because revised D-3 turns entirely on the difference.
 * Claude Code announces on stdout roughly 10ms BEFORE it asks over the MCP permission socket, on a
 * channel with no ordering guarantee against it — so an announcement before the decision is the
 * measured truth, and a fixture that hid it would let an adapter pass conformance behaviour 4
 * without ever buffering.
 */
const isGatedAnnouncement = (provider: TranscriptProvider, frame: TranscriptFrame): boolean => {
  const value = emitted(frame);
  if (!isRecord(value)) return false;
  switch (provider) {
    case "claude":
      return claudeContentHas(value, "tool_use");
    case "codex": {
      if (value["method"] !== "item/started") return false;
      const itemType = readAt(value, "params", "item", "type");
      return typeof itemType === "string" && CODEX_GATED_ITEM_TYPES.has(itemType);
    }
    case "acp": {
      if (value["method"] !== "session/update") return false;
      return readAt(value, "params", "update", "sessionUpdate") === "tool_call";
    }
  }
};

/**
 * The gated call actually HAPPENING — the observable side effect that a denial would have
 * prevented. This is what must never precede the decision, in any fixture, for any provider.
 */
const isGatedSideEffect = (provider: TranscriptProvider, frame: TranscriptFrame): boolean => {
  const value = emitted(frame);
  if (!isRecord(value)) return false;
  switch (provider) {
    case "claude":
      return claudeContentHas(value, "tool_result");
    case "codex": {
      if (value["method"] !== "item/completed") return false;
      const itemType = readAt(value, "params", "item", "type");
      return typeof itemType === "string" && CODEX_GATED_ITEM_TYPES.has(itemType);
    }
    case "acp": {
      if (value["method"] !== "session/update") return false;
      return readAt(value, "params", "update", "sessionUpdate") === "tool_call_update";
    }
  }
};

const findIndex = (
  frames: readonly TranscriptFrame[],
  predicate: (frame: TranscriptFrame) => boolean
): number => frames.findIndex(predicate);

/**
 * The `awaitStdin` that gates `sideEffectIndex` — the last one before it.
 *
 * Not simply the first `awaitStdin` in the transcript: Codex and ACP are JSON-RPC servers whose
 * transcripts open by waiting for the client's `initialize`, so frame 0 is a handshake, not a
 * permission decision. Taking the nearest preceding wait is what makes this predicate mean the same
 * thing across a stdio CLI and a JSON-RPC server.
 */
const decisionGating = (frames: readonly TranscriptFrame[], sideEffectIndex: number): number => {
  for (let index = sideEffectIndex - 1; index >= 0; index -= 1) {
    if (frames[index]?.kind === "awaitStdin") return index;
  }
  return -1;
};

describe("checked-in transcript fixtures", () => {
  it("finds fixtures for every provider", () => {
    expect(FIXTURES.length).toBeGreaterThan(0);
    for (const provider of TRANSCRIPT_PROVIDERS) {
      expect(forProvider(provider).length).toBeGreaterThan(0);
    }
  });

  it.each(FIXTURES.map((entry) => [entry.filePath, entry] as const))(
    "%s parses against the fixture format",
    (_filePath, entry) => {
      expect(() => parseTranscriptFixture(JSON.parse(entry.text))).not.toThrow();
      expect(entry.fixture.frames.length).toBeGreaterThan(0);
    }
  );

  it.each(FIXTURES.map((entry) => [entry.fileName, entry] as const))(
    "%s is named for the provider and scenario it declares",
    (_fileName, entry) => {
      const parsed = parseFileName(entry.fileName);
      expect(parsed.provider).toBe(entry.provider);
      expect(parsed.provider).toBe(entry.fixture.provenance.cli);
      expect(parsed.scenario).toBe(entry.fixture.scenario);
    }
  );

  it("covers every scenario for every provider", () => {
    for (const provider of TRANSCRIPT_PROVIDERS) {
      for (const scenario of TRANSCRIPT_SCENARIOS) {
        expect(
          forScenario(provider, scenario).length,
          `${provider} is missing a ${scenario} transcript`
        ).toBeGreaterThan(0);
      }
    }
  });

  it("authors ACP with two negotiation variants of the completes family", () => {
    const names = forScenario("acp", "completes").map((entry) => entry.fileName);
    expect(names).toContain("acp-completes.json");
    expect(names).toContain("acp-completes-minimal.json");
  });

  it.each(FIXTURES.map((entry) => [entry.fileName, entry] as const))(
    "%s trips no credential scan, in its frames or its recorded argv",
    (_fileName, entry) => {
      expect(containsSensitiveMaterial(entry.text)).toBe(false);
      for (const argument of entry.fixture.provenance.argv) {
        expect(containsSensitiveMaterial(argument)).toBe(false);
      }
      expect(containsSensitiveMaterial(entry.fixture.provenance.notes ?? "")).toBe(false);
    }
  );

  it.each(FIXTURES.map((entry) => [entry.fileName, entry] as const))(
    "%s records provenance that can be traced back to a provider",
    (_fileName, entry) => {
      const { provenance } = entry.fixture;
      expect(provenance.version.length).toBeGreaterThan(0);
      expect(provenance.argv.length).toBeGreaterThan(0);
      expect(provenance.notes).toBeDefined();
      // `codex app-server` is marked [experimental] by the CLI itself, so a future upgrade breaking
      // the full Codex profile stays diagnosable from the fixture.
      expect(provenance.stability).toBe(entry.provider === "codex" ? "experimental" : "stable");
      expect(provenance.source).toBe(entry.provider === "acp" ? "authored" : "recorded");
    }
  );

  describe("D-2 — interruption versus failure has one discriminator", () => {
    it.each(
      FIXTURES.filter((entry) => entry.scenario === "interrupted").map(
        (entry) => [entry.fileName, entry] as const
      )
    )("%s ends on a signal exit, after evidence, with no provider error shape", (_name, entry) => {
      const frames = entry.fixture.frames;
      const last = frames.at(-1);
      expect(last?.kind).toBe("exit");
      if (last?.kind !== "exit") throw new Error("unreachable: asserted above");
      expect(typeof last.signal).toBe("string");
      expect(last.signal).not.toBe("");
      expect(last.code).toBeNull();

      // Evidence-bearing, not merely "some emit frame" — see isEvidenceBearing. A handshake-only
      // transcript describes a session that produced nothing, which D-2 classifies as `failed`.
      const evidence = frames.filter((frame) => isEvidenceBearing(entry.provider, frame));
      expect(
        evidence.length,
        "an `interrupted` transcript must carry evidence to preserve; protocol handshakes are not evidence"
      ).toBeGreaterThan(0);

      for (const frame of frames) {
        expect(isProviderErrorShape(entry.provider, frame)).toBe(false);
      }
    });

    it.each(
      FIXTURES.filter((entry) => entry.scenario === "fails").map(
        (entry) => [entry.fileName, entry] as const
      )
    )("%s ends on a provider error shape, not merely a non-zero exit", (_name, entry) => {
      const frames = entry.fixture.frames;
      const errorIndex = findIndex(frames, (frame) => isProviderErrorShape(entry.provider, frame));
      expect(errorIndex, "a `fails` transcript must carry a provider error shape").toBeGreaterThan(
        -1
      );

      const last = frames.at(-1);
      expect(last?.kind).toBe("exit");
      if (last?.kind !== "exit") throw new Error("unreachable: asserted above");
      expect(last.signal).toBeNull();
      expect(errorIndex).toBeLessThan(frames.length - 1);
    });

    it.each(
      FIXTURES.filter((entry) => entry.scenario === "completes").map(
        (entry) => [entry.fileName, entry] as const
      )
    )("%s reaches a clean exit with no provider error shape", (_name, entry) => {
      const frames = entry.fixture.frames;
      const last = frames.at(-1);
      expect(last?.kind).toBe("exit");
      if (last?.kind !== "exit") throw new Error("unreachable: asserted above");
      expect(last.code).toBe(0);
      expect(last.signal).toBeNull();
      for (const frame of frames) {
        expect(isProviderErrorShape(entry.provider, frame)).toBe(false);
      }
    });
  });

  describe("D-3 — an approval-gated call surfaces as a permission request only", () => {
    it.each(
      FIXTURES.filter((entry) => entry.scenario === "requests_permission").map(
        (entry) => [entry.fileName, entry] as const
      )
    )("%s gates the side effect behind the decision", (_name, entry) => {
      const frames = entry.fixture.frames;

      // The invariant that actually matters, and the one conformance behaviour 4 rests on: the
      // observable side effect never precedes the decision. A denial would have prevented it.
      const sideEffectIndex = findIndex(frames, (frame) =>
        isGatedSideEffect(entry.provider, frame)
      );
      expect(sideEffectIndex, "no gated side-effect frame found").toBeGreaterThan(-1);

      expect(
        decisionGating(frames, sideEffectIndex),
        "the gated side effect must be preceded by an awaitStdin standing for its decision"
      ).toBeGreaterThan(-1);
    });

    it("records Claude's real cross-channel ordering rather than a staged one", () => {
      // Measured 2026-08-27: stdout announces the tool_use ~10ms before the MCP socket asks.
      // Pinned as a test so nobody "tidies" the fixture into an approval-first ordering the
      // provider does not have — that would let the adapter skip the buffering D-3 requires.
      const entry = FIXTURES.find(
        (candidate) =>
          candidate.provider === "claude" && candidate.scenario === "requests_permission"
      );
      expect(entry, "the Claude permission fixture must exist").toBeDefined();
      if (entry === undefined) throw new Error("unreachable: asserted above");

      const frames = entry.fixture.frames;
      const announcementIndex = findIndex(frames, (frame) => isGatedAnnouncement("claude", frame));
      const sideEffectIndex = findIndex(frames, (frame) => isGatedSideEffect("claude", frame));
      const decisionIndex = decisionGating(frames, sideEffectIndex);

      expect(announcementIndex, "no tool_use announcement found").toBeGreaterThan(-1);
      expect(decisionIndex, "no gating decision found").toBeGreaterThan(-1);
      expect(
        announcementIndex,
        "Claude announces the tool_use BEFORE the permission decision; the fixture must record that"
      ).toBeLessThan(decisionIndex);
    });

    it.each(
      FIXTURES.filter(
        (entry) => entry.scenario === "requests_permission" && entry.provider !== "claude"
      ).map((entry) => [entry.fileName, entry] as const)
    )("%s carries its approval request in band, before the decision", (_name, entry) => {
      // Codex and ACP ask over the same JSON-RPC channel they stream on, so unlike Claude their
      // ask is an ordered frame and must precede the decision it is asking for.
      const frames = entry.fixture.frames;
      const approvalIndex = findIndex(frames, (frame) => isApprovalRequest(entry.provider, frame));
      const sideEffectIndex = findIndex(frames, (frame) =>
        isGatedSideEffect(entry.provider, frame)
      );
      const decisionIndex = decisionGating(frames, sideEffectIndex);

      expect(approvalIndex, "no in-band approval request frame found").toBeGreaterThan(-1);
      expect(decisionIndex, "no gating decision found").toBeGreaterThan(-1);
      expect(approvalIndex, "the ask must precede the decision it asks for").toBeLessThan(
        decisionIndex
      );
    });
  });

  describe("a pause is blocking, not slow", () => {
    it.each(
      FIXTURES.filter((entry) => entry.scenario === "pauses").map(
        (entry) => [entry.fileName, entry] as const
      )
    )("%s blocks on stdin", (_name, entry) => {
      const waits = entry.fixture.frames.filter((frame) => frame.kind === "awaitStdin");
      expect(waits.length).toBeGreaterThan(0);
    });
  });

  describe("a malformed transcript corrupts exactly one frame", () => {
    it.each(
      FIXTURES.filter((entry) => entry.scenario === "malformed").map(
        (entry) => [entry.fileName, entry] as const
      )
    )("%s carries one unparseable-as-provider-shape emit", (_name, entry) => {
      const corrupt = entry.fixture.frames.filter(
        (frame) => frame.kind === "emit" && typeof frame.value === "string"
      );
      expect(corrupt).toHaveLength(1);
      // Provider diagnostics belong on stderr and must never reach the frame parser.
      const stderr = entry.fixture.frames.filter((frame) => frame.kind === "emitStderr");
      expect(stderr.length).toBeGreaterThan(0);
    });
  });

  describe("usage is honest about what the provider does not report", () => {
    it("keeps Claude's per-message usage free of cost and thinking tokens", () => {
      const [fixture] = forScenario("claude", "completes");
      expect(fixture).toBeDefined();
      if (fixture === undefined) throw new Error("unreachable: asserted above");

      const perMessageUsages = fixture.fixture.frames
        .map((frame) => readAt(emitted(frame), "message", "usage"))
        .filter(isRecord);
      expect(perMessageUsages.length).toBeGreaterThan(0);
      for (const usage of perMessageUsages) {
        expect(usage["input_tokens"]).toBeTypeOf("number");
        expect(usage["output_tokens"]).toBeTypeOf("number");
        expect(usage["total_cost_usd"]).toBeUndefined();
        expect(usage["output_tokens_details"]).toBeUndefined();
      }
    });

    it("keeps Codex's token usage free of cost", () => {
      const [fixture] = forScenario("codex", "completes");
      expect(fixture).toBeDefined();
      if (fixture === undefined) throw new Error("unreachable: asserted above");

      const totals = fixture.fixture.frames
        .filter(
          (frame) =>
            isRecord(emitted(frame)) &&
            readAt(emitted(frame), "method") === "thread/tokenUsage/updated"
        )
        .map((frame) => readAt(emitted(frame), "params", "tokenUsage", "total"))
        .filter(isRecord);
      expect(totals.length).toBeGreaterThan(0);
      for (const total of totals) {
        expect(total["inputTokens"]).toBeTypeOf("number");
        expect(total["cachedInputTokens"]).toBeTypeOf("number");
        expect(total["outputTokens"]).toBeTypeOf("number");
        expect(total["reasoningOutputTokens"]).toBeTypeOf("number");
        expect(total["costUsd"]).toBeUndefined();
        expect(total["cost"]).toBeUndefined();
      }
    });

    it("reports no usage at all for ACP, across a session that genuinely produced work", () => {
      // D-14 standing question: absence assertions alone are the environment's default here. An
      // empty `forProvider` result skips the loop, and a content-free fixture contains no usage
      // keys either — both would pass while proving nothing. The companions below are what make
      // the absence a finding about a real session rather than about an empty file.
      const entries = forProvider("acp");
      expect(entries.length, "no ACP fixtures were loaded at all").toBeGreaterThan(0);

      for (const entry of entries) {
        expect(entry.text).not.toContain("tokenUsage");
        expect(entry.text).not.toContain("inputTokens");
      }

      // The positive half: ACP's honest `unknown` for conformance behaviour 8 is only meaningful
      // because a real ACP session still does work and still reports no figures for it.
      //
      // Asserted across EVERY completes variant, not `const [first] = ...`. There are two
      // (`acp-completes.json` and `acp-completes-minimal.json`), and `-` sorts before `.`, so
      // destructuring silently inspected the minimal one — a guard that checks a different file
      // than its author believes is the same vacuity wearing another costume.
      const completesVariants = forScenario("acp", "completes");
      expect(completesVariants.length, "no ACP completes fixtures were found").toBeGreaterThan(0);
      for (const completes of completesVariants) {
        const evidence = completes.fixture.frames.filter((frame) =>
          isEvidenceBearing("acp", frame)
        );
        expect(
          evidence.length,
          `${completes.fileName} must carry evidence-bearing frames, or 'no usage' is a statement about an empty transcript`
        ).toBeGreaterThan(0);
      }
    });
  });
});
