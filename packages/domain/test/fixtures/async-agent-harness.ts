import type {
  AgentPermissionResponderPort,
  AgentPermissionResponse,
  AgentSessionStreamEvent
} from "@autostack/contracts";

import type {
  AgentHarnessConformanceFixture,
  AgentHarnessConformanceScenario,
  AgentHarnessConformanceSubject,
  AgentHarnessMinimalScenario
} from "../../src/testing/agent-harness-conformance-fixture.js";
import { agentHarnessConformanceFixture } from "./agent-harness.js";

/**
 * The same fake, moved behind a macrotask boundary.
 *
 * Every event is delivered on its own turn of the event loop and every operation resolves on one,
 * which is how an out-of-process adapter behaves: a CLI child process hands over one stdout frame
 * per turn, and a request to it is answered a turn later at the earliest. The in-process fake
 * resolves its waiters synchronously, so on its own it cannot tell whether the suite's notion of a
 * paused session is genuinely event-driven or merely calibrated to microtask timing.
 *
 * This subject is the standing guard against that calibration. It has no fake-specific knowledge —
 * it wraps whatever the reference fixture produces — so the suite passing against both is evidence
 * that the pause detection follows the transport rather than a fixed number of turns.
 */
const macrotask = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

/** Turns of the event loop the transport is given to hand over a frame it already holds. */
const QUIESCE_TURNS = 4;

const afterMacrotask = async <T>(operation: () => Promise<T>): Promise<T> => {
  await macrotask();
  return operation();
};

const deferredStream = (
  stream: AsyncIterable<AgentSessionStreamEvent>
): AsyncIterable<AgentSessionStreamEvent> =>
  (async function* () {
    for await (const event of stream) {
      await macrotask();
      yield event;
    }
  })();

const deferSubject = (subject: AgentHarnessConformanceSubject): AgentHarnessConformanceSubject => {
  const harness = subject.harness;
  const respond: AgentPermissionResponderPort["respondToPermission"] | undefined =
    harness.respondToPermission;

  return {
    ...subject,
    harness: {
      descriptor: harness.descriptor,
      start: (request) => deferredStream(harness.start(request)),
      resume: (request) => deferredStream(harness.resume(request)),
      steer: (request) => afterMacrotask(() => harness.steer(request)),
      cancel: (request) => afterMacrotask(() => harness.cancel(request)),
      // Present only when the wrapped adapter implements it, so the structural honesty rule the
      // suite probes still describes the adapter rather than this wrapper.
      ...(respond === undefined
        ? {}
        : {
            respondToPermission: (response: AgentPermissionResponse) =>
              afterMacrotask(() => respond.call(harness, response))
          })
    },
    pendingPermission: () => afterMacrotask(() => subject.pendingPermission()),
    quiesce: async () => {
      for (let turn = 0; turn < QUIESCE_TURNS; turn += 1) await macrotask();
    },
    dispose: () => afterMacrotask(() => subject.dispose())
  };
};

export const asyncAgentHarnessConformanceFixture: AgentHarnessConformanceFixture = {
  createFullCapabilityHarness: async (scenario: AgentHarnessConformanceScenario) =>
    deferSubject(await agentHarnessConformanceFixture.createFullCapabilityHarness(scenario)),
  createMinimalCapabilityHarness: async (scenario: AgentHarnessMinimalScenario) =>
    deferSubject(await agentHarnessConformanceFixture.createMinimalCapabilityHarness(scenario))
};
