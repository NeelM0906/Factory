import { describe, expect, it } from "vitest";

import { AgentHarnessDescriptorSchema } from "@autostack/contracts";

import type { AgentHarnessConformanceFixture } from "./agent-harness-conformance-fixture.js";
import {
  collect,
  drainPaused,
  expectSessionStream,
  isTerminalEvent,
  iterate,
  pullUntilPaused,
  settle
} from "./agent-harness-conformance-support.js";

/** Behaviours 1, 2, 3, and 7: what a session is, whatever the adapter behind it. */
export const describeAgentHarnessLifecycleConformance = (
  fixture: AgentHarnessConformanceFixture
): void => {
  describe("lifecycle", () => {
    it("declares a schema-valid descriptor whose capabilities match its port surface", async () => {
      const full = await fixture.createFullCapabilityHarness("completes");
      const minimal = await fixture.createMinimalCapabilityHarness("completes");
      try {
        for (const subject of [full, minimal]) {
          const descriptor = AgentHarnessDescriptorSchema.parse(subject.harness.descriptor);
          expect(descriptor).toEqual(subject.harness.descriptor);
          // The responder is a separate interface: an adapter without the capability must not
          // implement it at all, rather than implement it and reject.
          expect("respondToPermission" in subject.harness).toBe(
            descriptor.capabilities.permissions
          );
        }
        expect(full.harness.descriptor.capabilities).toEqual({
          resume: true,
          steering: true,
          permissions: true,
          structuredPlans: true
        });
        expect(minimal.harness.descriptor.capabilities).toEqual({
          resume: false,
          steering: false,
          permissions: false,
          structuredPlans: false
        });
      } finally {
        await full.dispose();
        await minimal.dispose();
      }
    });

    it("completes once, disposes idempotently, and refuses a disposed session", async () => {
      const subject = await fixture.createFullCapabilityHarness("completes");
      const events = await collect(subject.harness.start(subject.invocation));

      const terminals = events.filter(isTerminalEvent);
      expect(terminals).toHaveLength(1);
      expect(terminals[0]?.type).toBe("completed");
      expect(events.at(-1)).toBe(terminals[0]);

      await expect(subject.dispose()).resolves.toBeUndefined();
      await expect(subject.dispose()).resolves.toBeUndefined();

      await expect(subject.harness.steer(subject.steer)).rejects.toBeDefined();
      await expect(subject.harness.cancel(subject.cancel)).rejects.toBeDefined();
      await expect(
        collect(subject.harness.resume(subject.resumeRequest(events)))
      ).rejects.toBeDefined();
    });

    it("emits only contract-valid events in one strictly increasing sequence space", async () => {
      const subject = await fixture.createFullCapabilityHarness("completes");
      try {
        const events = await collect(subject.harness.start(subject.invocation));

        expect(events.length).toBeGreaterThan(1);
        expect(events[0]?.sequence).toBe(1);
        expectSessionStream(events, { sessionId: subject.invocation.agentSessionId, after: 0 });
        // expectSessionStream pins the terminal to the end of the stream; assert the session
        // actually reached one, so an empty or truncated stream cannot pass vacuously.
        expect(events.filter(isTerminalEvent)).toHaveLength(1);
      } finally {
        await subject.dispose();
      }
    });

    it("cancels a running session into the cancelled shape and never the success shape", async () => {
      const subject = await fixture.createFullCapabilityHarness("pauses");
      try {
        const iterator = iterate(subject.harness.start(subject.invocation));
        const paused = await pullUntilPaused(iterator);

        await expect(subject.harness.cancel(subject.cancel)).resolves.toBeUndefined();

        const events = await drainPaused(paused, iterator);
        expectSessionStream(events, { sessionId: subject.invocation.agentSessionId, after: 0 });
        expect(events.filter(isTerminalEvent)).toHaveLength(1);
        expect(events.at(-1)?.type).toBe("cancelled");
        expect(events.some((event) => event.type === "completed")).toBe(false);

        // After the terminal, cancellation is either a no-op or a clean rejection — never a hang.
        const repeated = await settle(subject.harness.cancel(subject.cancel));
        if (repeated.rejected) expect(repeated.reason).toBeInstanceOf(Error);
      } finally {
        await subject.dispose();
      }
    });
  });
};
