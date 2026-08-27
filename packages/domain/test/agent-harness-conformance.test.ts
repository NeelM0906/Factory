import { describeAgentHarnessConformance } from "../src/testing/agent-harness-conformance.js";
import { agentHarnessConformanceFixture } from "./fixtures/agent-harness.js";
import { asyncAgentHarnessConformanceFixture } from "./fixtures/async-agent-harness.js";

describeAgentHarnessConformance("scripted fake agent harness", agentHarnessConformanceFixture);

// The same subject behind a macrotask boundary, standing in for S2's out-of-process CLI adapters.
// The suite must pass identically against both, or its pause detection is calibrated to the fake.
describeAgentHarnessConformance(
  "scripted fake agent harness over an asynchronous transport",
  asyncAgentHarnessConformanceFixture
);
