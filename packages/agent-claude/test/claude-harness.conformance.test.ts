/**
 * Conformance suite for the Claude Code harness.
 *
 * Runs `describeAgentHarnessConformance` from `@autostack/domain/testing` against
 * the Claude harness, backed by conformance-specific transcripts that produce the
 * exact event sequences the suite requires (true pauses, D-3 compliant ordering,
 * allow-path permissions).
 */

import { describeAgentHarnessConformance } from "@autostack/domain/testing";
import { claudeConformanceFixture } from "./fixtures/conformance.js";

describeAgentHarnessConformance("claude-code", claudeConformanceFixture);
