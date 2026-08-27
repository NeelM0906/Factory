/**
 * Types for `record-transcripts.mjs`.
 *
 * The recorder is plain ESM JavaScript because it is an operator script run with a bare `node`, but
 * its pure exports are unit-tested from TypeScript. This declaration is the seam. It deliberately
 * types only what the tests and `main` need; the recording internals stay private to the module.
 */

import type {
  TranscriptFixture,
  TranscriptFrame,
  TranscriptScenario
} from "../src/testing/transcript-format.js";

export type RecordableProvider = "claude" | "codex";

export interface ScenarioPlan {
  readonly objective: string | null;
  readonly provocation: string;
  readonly streamingInput: boolean;
}

export interface CodexHandshakeStep {
  readonly message: Record<string, unknown>;
  readonly match: Record<string, unknown>;
}

export type ParsedArguments =
  | { readonly help: true }
  | {
      readonly help: false;
      readonly provider: RecordableProvider;
      readonly scenario: TranscriptScenario;
      readonly out: string;
    };

/** Structure-preserving: strings are rewritten, everything else keeps its shape. */
export type TranscriptNormalizer = <T>(value: T) => T;

export type SensitiveMaterialScan = (value: string) => boolean;

export declare const TRANSCRIPT_PLACEHOLDERS: Readonly<{
  home: string;
  workspace: string;
  username: string;
}>;
export declare const TRANSCRIPT_FRAME_KINDS: readonly TranscriptFrame["kind"][];
export declare const TRANSCRIPT_SCENARIOS: readonly TranscriptScenario[];
export declare const RECORDABLE_PROVIDERS: readonly RecordableProvider[];

export declare class UsageError extends Error {
  constructor(message: string);
}
export declare const USAGE: string;
export declare const parseArguments: (argv: readonly string[]) => ParsedArguments;

export declare const INVALID_MODEL_NAME: string;
export declare const CLAUDE_PERMISSION_TOOL: string;
export declare const CLAUDE_SESSION_IDS: Readonly<
  Record<Exclude<TranscriptScenario, "malformed">, string>
>;
export declare const SCENARIO_PLAN: Readonly<Record<TranscriptScenario, ScenarioPlan>>;
export declare const scenarioPlan: (scenario: string) => ScenarioPlan;

export declare const buildClaudeArgv: (options: {
  readonly scenario: TranscriptScenario;
  readonly sessionId: string;
  readonly mcpConfigPath?: string;
}) => string[];
export declare const buildCodexArgv: (options: {
  readonly scenario: TranscriptScenario;
}) => string[];
export declare const CODEX_THREAD_ID_TOKEN: string;
export declare const CODEX_CLIENT_INFO: Readonly<{
  name: string;
  title: string;
  version: string;
}>;
export declare const buildCodexHandshake: (options: {
  readonly scenario: TranscriptScenario;
  readonly workspace: string;
}) => readonly CodexHandshakeStep[];
export declare const buildClaudeStdinMessage: (objective: string) => Record<string, unknown>;
export declare const PAUSE_STDIN_MATCH: Readonly<
  Record<RecordableProvider, Readonly<Record<string, string>>>
>;

export declare const isEvidenceBearingFrame: (provider: string, value: unknown) => boolean;

export declare const createTranscriptNormalizer: (values: {
  readonly home?: string | readonly string[];
  readonly workspace?: string | readonly string[];
  readonly username?: string | readonly string[];
}) => TranscriptNormalizer;
export declare const normalizeFixtureDocument: <T>(
  document: T,
  normalize: TranscriptNormalizer
) => T;

export declare const findSensitiveLocations: (
  document: unknown,
  containsSensitiveMaterial: SensitiveMaterialScan
) => string[];
export declare const assertScanClean: (
  document: unknown,
  containsSensitiveMaterial: SensitiveMaterialScan,
  context?: { readonly provider?: string; readonly scenario?: string }
) => void;

export declare const providerStability: (provider: string) => "stable" | "experimental";
export declare const buildFixtureDocument: (options: {
  readonly provider: RecordableProvider;
  readonly scenario: TranscriptScenario;
  readonly version: string;
  readonly recordedAt: string;
  readonly argv: readonly string[];
  readonly frames: readonly TranscriptFrame[];
  readonly notes?: string;
}) => TranscriptFixture;
export declare const deriveMalformedFixture: (
  completesDocument: TranscriptFixture,
  recordedAt: string
) => TranscriptFixture;

export declare const assertWorkspaceOutsideCheckout: (
  workspace: string,
  checkoutRoot: string
) => void;

export declare const main: (argv: readonly string[]) => Promise<number>;
