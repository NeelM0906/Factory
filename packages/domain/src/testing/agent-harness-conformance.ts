import { describe } from "vitest";

import type { AgentHarnessConformanceFixture } from "./agent-harness-conformance-fixture.js";
import { describeAgentHarnessCapabilityConformance } from "./agent-harness-conformance-capabilities.js";
import { describeAgentHarnessEvidenceConformance } from "./agent-harness-conformance-evidence.js";
import { describeAgentHarnessLifecycleConformance } from "./agent-harness-conformance-lifecycle.js";

export {
  AGENT_HARNESS_CONFORMANCE_SCENARIOS,
  type AgentHarnessConformanceFixture,
  type AgentHarnessConformanceScenario,
  type AgentHarnessConformanceSubject,
  type AgentHarnessMinimalScenario
} from "./agent-harness-conformance-fixture.js";

/**
 * The behaviour every `AgentHarnessPort` implementation shares, asserted through the port alone.
 *
 * Spec §9.1 requires the native harness and the Claude Code, Codex, and ACP adapters to be
 * indistinguishable at this boundary. Every assertion here therefore reads only what the port
 * exposes; the fixture's scenarios and envelopes are the sole side channel, and they carry no
 * adapter-specific knowledge into the suite.
 */
export const describeAgentHarnessConformance = (
  name: string,
  fixture: AgentHarnessConformanceFixture
): void => {
  describe(name, () => {
    describeAgentHarnessLifecycleConformance(fixture);
    describeAgentHarnessCapabilityConformance(fixture);
    describeAgentHarnessEvidenceConformance(fixture);
  });
};
