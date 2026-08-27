import { describeAgentHarnessConformance } from "../src/testing/agent-harness-conformance.js";
import { agentHarnessConformanceFixture } from "./fixtures/agent-harness.js";

describeAgentHarnessConformance("scripted fake agent harness", agentHarnessConformanceFixture);
