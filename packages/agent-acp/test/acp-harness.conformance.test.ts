/**
 * ACP harness conformance suite.
 *
 * Runs the shared behaviour suite (lifecycle, capabilities, evidence) against
 * the AcpHarness backed by the fixture ACP agent that replays transcripts
 * from test/fixtures/transcripts/conformance-*.json.
 */

import { describeAgentHarnessConformance } from "@autostack/domain/testing";

import { acpConformanceFixture } from "./fixtures/conformance.js";

describeAgentHarnessConformance("AcpHarness conformance", acpConformanceFixture);
