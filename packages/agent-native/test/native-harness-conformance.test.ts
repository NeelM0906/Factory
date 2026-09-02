import { describeAgentHarnessConformance } from "@autostack/domain/testing";

import { asyncNativeHarnessConformanceFixture } from "./fixtures/async-native-harness-fixture.js";
import { nativeHarnessConformanceFixture } from "./fixtures/native-harness-fixture.js";

describeAgentHarnessConformance("native agent harness", nativeHarnessConformanceFixture);
describeAgentHarnessConformance(
  "native agent harness over an asynchronous transport",
  asyncNativeHarnessConformanceFixture
);
