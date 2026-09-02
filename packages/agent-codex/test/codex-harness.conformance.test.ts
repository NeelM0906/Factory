/**
 * Conformance suite for the Codex harness.
 *
 * Runs `describeAgentHarnessConformance` from `@autostack/domain/testing` against
 * the Codex harness, backed by transcripts that produce the exact event sequences
 * the suite requires (true pauses, D-3 compliant ordering, allow-path permissions).
 */

import { describeAgentHarnessConformance } from "@autostack/domain/testing";
import { codexConformanceFixture } from "./fixtures/conformance.js";

describeAgentHarnessConformance("codex", codexConformanceFixture);
