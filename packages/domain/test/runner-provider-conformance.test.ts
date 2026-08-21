import {
  describeLocalRunnerLifecycleConformance,
  describeRunnerProviderConformance
} from "../src/testing/runner-provider-conformance.js";
import {
  localRunnerLifecycleConformanceFixture,
  runnerProviderConformanceFixture
} from "./fixtures/runner-provider.js";

describeRunnerProviderConformance("stateful in-memory runner", runnerProviderConformanceFixture);
describeLocalRunnerLifecycleConformance(
  "stateful in-memory lifecycle",
  localRunnerLifecycleConformanceFixture
);
