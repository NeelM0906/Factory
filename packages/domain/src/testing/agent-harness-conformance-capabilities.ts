import { describe, expect, it } from "vitest";

import { AgentPermissionRequestSchema, type AgentSessionStreamEvent } from "@autostack/contracts";

import type { AgentHarnessConformanceFixture } from "./agent-harness-conformance-fixture.js";
import {
  collect,
  drain,
  drainPaused,
  expectSessionStream,
  isPending,
  isTerminalEvent,
  iterate,
  pullUntilPaused,
  requireResponder,
  take
} from "./agent-harness-conformance-support.js";

/** A permission reference no scenario may issue, used to probe the unknown-decision rejection. */
const UNKNOWN_PERMISSION_REF = "conformance.unknown-permission";

const mentions = (event: AgentSessionStreamEvent, text: string): boolean =>
  "text" in event && event.text.includes(text);

const SIDE_EFFECT_TYPES: readonly string[] = ["tool_call", "file_change", "completed"];

/** Behaviours 4, 5, and 6: every capability the descriptor declares, and every one it denies. */
export const describeAgentHarnessCapabilityConformance = (
  fixture: AgentHarnessConformanceFixture
): void => {
  describe("capabilities", () => {
    it("holds side effects until a permission decision arrives and refuses foreign decisions", async () => {
      const subject = await fixture.createFullCapabilityHarness("requests_permission");
      try {
        const iterator = iterate(subject.harness.start(subject.invocation));
        const paused = await pullUntilPaused(iterator);

        const requested = paused.events.at(-1);
        expect(requested?.type).toBe("permission_requested");
        if (requested?.type !== "permission_requested") throw new TypeError("unreachable");
        expect(paused.events.some((event) => SIDE_EFFECT_TYPES.includes(event.type))).toBe(false);

        const pending = AgentPermissionRequestSchema.parse(await subject.pendingPermission());
        expect(pending.sessionId).toBe(subject.invocation.agentSessionId);
        expect(pending.permissionRef).toBe(requested.permissionRef);
        expect(pending.evidenceDigest).toBe(requested.evidenceDigest);

        const allow = pending.options.find(
          (option) => option.kind === "allow_once" || option.kind === "allow_always"
        );
        if (allow === undefined) throw new TypeError("The scenario must offer an allow option.");

        const respond = requireResponder(subject);
        await expect(
          respond(
            subject.permissionResponse(
              { ...pending, permissionRef: UNKNOWN_PERMISSION_REF },
              allow.optionId
            )
          )
        ).rejects.toBeDefined();
        expect(await isPending(paused.pending)).toBe(true);

        await expect(
          respond(subject.permissionResponse(pending, allow.optionId))
        ).resolves.toBeUndefined();

        const events = await drainPaused(paused, iterator);
        expectSessionStream(events, { sessionId: subject.invocation.agentSessionId, after: 0 });
        expect(events.find((event) => event.type === "permission_resolved")).toMatchObject({
          permissionRef: pending.permissionRef,
          selectedOptionId: allow.optionId
        });
        expect(events.some((event) => SIDE_EFFECT_TYPES.includes(event.type))).toBe(true);

        // The permission is settled; deciding it a second time is not a replay, it is a defect.
        await expect(
          respond(subject.permissionResponse(pending, allow.optionId))
        ).rejects.toBeDefined();
      } finally {
        await subject.dispose();
      }
    });

    it("steers a declared session and refuses steering the descriptor denies", async () => {
      const full = await fixture.createFullCapabilityHarness("pauses");
      const minimal = await fixture.createMinimalCapabilityHarness("completes");
      try {
        const iterator = iterate(full.harness.start(full.invocation));
        const paused = await pullUntilPaused(iterator);
        expect(paused.events.every((event) => !mentions(event, full.steer.instruction))).toBe(true);

        await expect(full.harness.steer(full.steer)).resolves.toBeUndefined();

        const steered = await drainPaused(paused, iterator);
        expectSessionStream(steered, { sessionId: full.invocation.agentSessionId, after: 0 });
        expect(steered.some((event) => mentions(event, full.steer.instruction))).toBe(true);

        // The undeclared capability is refused, and refusing it leaves the session intact.
        const minimalIterator = iterate(minimal.harness.start(minimal.invocation));
        const observed = await take(minimalIterator, 1);
        await expect(minimal.harness.steer(minimal.steer)).rejects.toBeInstanceOf(Error);
        const events = await drain(minimalIterator, observed);
        expectSessionStream(events, { sessionId: minimal.invocation.agentSessionId, after: 0 });
        expect(events.filter(isTerminalEvent)).toHaveLength(1);
      } finally {
        await full.dispose();
        await minimal.dispose();
      }
    });

    it("resumes the same session identity and refuses resumption the descriptor denies", async () => {
      const full = await fixture.createFullCapabilityHarness("completes");
      const minimal = await fixture.createMinimalCapabilityHarness("completes");
      try {
        const iterator = iterate(full.harness.start(full.invocation));
        const observed = await take(iterator, 2);
        await iterator.return?.(undefined);
        const lastSequence = observed.at(-1)?.sequence ?? 0;

        const request = full.resumeRequest(observed);
        // Spec §9.1 forbids emulated resume: the continuation is the same session, not a new one.
        expect(request.sessionId).toBe(full.invocation.agentSessionId);
        const resumed = await collect(full.harness.resume(request));
        expect(resumed.length).toBeGreaterThan(0);
        expectSessionStream(resumed, {
          sessionId: full.invocation.agentSessionId,
          after: lastSequence
        });
        expect(resumed.filter(isTerminalEvent)).toHaveLength(1);

        const minimalIterator = iterate(minimal.harness.start(minimal.invocation));
        const minimalObserved = await take(minimalIterator, 1);
        await minimalIterator.return?.(undefined);
        await expect(
          collect(minimal.harness.resume(minimal.resumeRequest(minimalObserved)))
        ).rejects.toBeInstanceOf(Error);
      } finally {
        await full.dispose();
        await minimal.dispose();
      }
    });
  });
};
