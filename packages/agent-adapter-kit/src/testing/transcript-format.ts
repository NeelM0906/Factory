import { z } from "zod";

/**
 * The recorded-transcript format every fixture provider process replays.
 *
 * It lives in `src/testing` rather than a package-local `test/` directory for the same reason the
 * agent-harness conformance suite does (`packages/domain/src/testing`): three separate adapter
 * packages load these fixtures, and a `test/` module is not reachable across a package boundary.
 *
 * Fixtures are data, and their provenance travels with them. A transcript that cannot say which CLI
 * version produced it, under which argv, is not evidence — it is a guess that happens to be
 * checked in.
 */

/**
 * `malformed` is not a conformance scenario. The suite's five are the contract; this sixth exists
 * because the charter requires malformed provider output to be a classified failure rather than a
 * crash, and that needs a transcript no conformance subject would ever replay.
 */
export const TRANSCRIPT_SCENARIOS = [
  "completes",
  "pauses",
  "requests_permission",
  "fails",
  "interrupted",
  "malformed"
] as const;

export const TranscriptScenarioSchema = z.enum(TRANSCRIPT_SCENARIOS);
export type TranscriptScenario = z.infer<typeof TranscriptScenarioSchema>;

export const TRANSCRIPT_PROVIDERS = ["claude", "codex", "acp"] as const;
export const TranscriptProviderSchema = z.enum(TRANSCRIPT_PROVIDERS);
export type TranscriptProvider = z.infer<typeof TranscriptProviderSchema>;

/**
 * `experimental` is load-bearing, not decoration: `codex app-server` is marked `[experimental]` by
 * the CLI itself, so a future upgrade breaking the full Codex profile should be diagnosable from the
 * fixture rather than mysterious.
 */
export const TranscriptProvenanceSchema = z
  .object({
    source: z.enum(["recorded", "authored"]),
    cli: TranscriptProviderSchema,
    version: z.string().trim().min(1).max(200),
    recordedAt: z.iso.datetime(),
    argv: z.array(z.string().max(32_768)).max(256),
    stability: z.enum(["stable", "experimental"]),
    notes: z.string().max(8_000).optional()
  })
  .strict();

/**
 * One scripted step for the fixture provider process.
 *
 * `kind` follows the discriminated-union style the domain fake's script already uses
 * (`FakeHarnessScript`), so a reader moving between the two is not learning a second shape.
 */
export const TranscriptFrameSchema = z.discriminatedUnion("kind", [
  /** Write one JSON frame to stdout. */
  z.object({ kind: z.literal("emit"), value: z.unknown() }).strict(),
  /**
   * Write to stderr. Provider diagnostics really do arrive here, and an adapter must surface them
   * without ever letting them reach the frame parser — which is only testable if fixtures can
   * produce them.
   */
  z.object({ kind: z.literal("emitStderr"), text: z.string().max(64_000) }).strict(),
  /**
   * Block until the client sends a frame matching `match` (a structural subset match, not equality,
   * so a fixture need not pin ids the client mints). This is what makes a `pauses` transcript
   * genuinely blocking rather than merely slow.
   */
  z.object({ kind: z.literal("awaitStdin"), match: z.unknown() }).strict(),
  /** Terminate. A `signal` exit with no prior error frame is what D-2 reduces to `interrupted`. */
  z
    .object({
      kind: z.literal("exit"),
      code: z.number().int().nullable(),
      signal: z.string().max(20).nullable()
    })
    .strict()
]);

export type TranscriptFrame = z.infer<typeof TranscriptFrameSchema>;

export const TranscriptFixtureSchema = z
  .object({
    provenance: TranscriptProvenanceSchema,
    scenario: TranscriptScenarioSchema,
    frames: z.array(TranscriptFrameSchema).min(1).max(2_000)
  })
  .strict();

export type TranscriptFixture = z.infer<typeof TranscriptFixtureSchema>;

/**
 * Placeholders the recorder substitutes for machine-specific values, in both frames and the
 * recorded argv. Normalization runs before the credential scan, never after: the scan is the gate,
 * and a fixture that still trips it is re-recorded rather than edited into compliance.
 */
export const TRANSCRIPT_PLACEHOLDERS = Object.freeze({
  home: "/home/agent",
  workspace: "/tmp/agent-workspace",
  username: "agent"
});

/** Parses a fixture document, failing closed on anything the format does not describe. */
export const parseTranscriptFixture = (value: unknown): TranscriptFixture =>
  TranscriptFixtureSchema.parse(value);
