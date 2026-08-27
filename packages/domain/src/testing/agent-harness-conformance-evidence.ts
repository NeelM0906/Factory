import { describe, expect, it } from "vitest";

import {
  AgentSessionDetailEventSchema,
  ModelCostSchema,
  ModelTokenUsageSchema,
  WorkflowFailureSchema,
  normalizeWorkflowFailureCode
} from "@autostack/contracts";

import type { AgentHarnessConformanceFixture } from "./agent-harness-conformance-fixture.js";
import {
  collect,
  expectSessionStream,
  isTerminalEvent
} from "./agent-harness-conformance-support.js";

/** Behaviours 8, 9, and 10: what a session leaves behind — usage, classification, and evidence. */
export const describeAgentHarnessEvidenceConformance = (
  fixture: AgentHarnessConformanceFixture
): void => {
  describe("evidence", () => {
    it("reports usage with unreported figures recorded as unknown rather than as zero", async () => {
      const subject = await fixture.createFullCapabilityHarness("completes");
      try {
        const events = await collect(subject.harness.start(subject.invocation));
        const usage = events.filter((event) => event.type === "usage");
        expect(usage.length).toBeGreaterThan(0);

        const figures = usage.flatMap((event) => {
          const tokens = ModelTokenUsageSchema.parse(event.tokens);
          const cost = ModelCostSchema.parse(event.cost);
          expect(tokens).toEqual(event.tokens);
          expect(cost).toEqual(event.cost);
          return [cost, ...Object.values(tokens)];
        });
        // The scenario reports at least one figure its provider never supplied. An adapter that
        // substitutes a fabricated number for it has no way to reach this shape.
        expect(figures.some((figure) => figure.state === "unknown")).toBe(true);
      } finally {
        await subject.dispose();
      }
    });

    it("terminates a provider failure in a stable classification the retry policy can consume", async () => {
      const subject = await fixture.createFullCapabilityHarness("fails");
      const replay = await fixture.createFullCapabilityHarness("fails");
      try {
        const events = await collect(subject.harness.start(subject.invocation));
        expectSessionStream(events, subject);
        const terminal = events.at(-1);
        expect(events.filter(isTerminalEvent)).toHaveLength(1);
        expect(terminal?.type).toBe("failed");
        if (terminal?.type !== "failed") throw new TypeError("unreachable");

        // The contract requires `code` to already be in the workflow-failure alphabet, so lifting
        // it must be a no-op. `normalizeWorkflowFailureCode` is the pipeline's own rule, shared
        // through contracts rather than re-derived here: it admits a code only unchanged, so a code
        // the adapter owes a mapping for comes back undefined instead of being quietly rewritten.
        expect(
          normalizeWorkflowFailureCode(terminal.code),
          `the failure code "${terminal.code}" must already match ^[a-z][a-z0-9_]{0,63}$ (lowercase snake_case, at most 64 characters); a code that normalization has to rewrite — a JSON-RPC numeric code such as -32601, or a dotted "provider.rate_limited" — must be mapped by the adapter before it is emitted`
        ).toBe(terminal.code);
        WorkflowFailureSchema.parse({
          code: terminal.code,
          name: terminal.code,
          message: terminal.message,
          retryable: terminal.retryable
        });
        // A code is an identifier a policy branches on, not a restatement of the operator message.
        expect(terminal.code).not.toBe(terminal.message);

        const replayed = (await collect(replay.harness.start(replay.invocation))).at(-1);
        expect(replayed?.type).toBe("failed");
        if (replayed?.type !== "failed") throw new TypeError("unreachable");
        expect({ code: replayed.code, retryable: replayed.retryable }).toEqual({
          code: terminal.code,
          retryable: terminal.retryable
        });
      } finally {
        await subject.dispose();
        await replay.dispose();
      }
    });

    it("marks host loss as interrupted while its partial evidence stays readable", async () => {
      const subject = await fixture.createFullCapabilityHarness("interrupted");
      try {
        const events = await collect(subject.harness.start(subject.invocation));
        expectSessionStream(events, subject);
        const interruptions = events.filter((event) => event.type === "interrupted");
        expect(interruptions).toHaveLength(1);

        const interrupted = interruptions[0];
        if (interrupted?.type !== "interrupted") throw new TypeError("unreachable");
        expect(AgentSessionDetailEventSchema.parse(interrupted)).toEqual(interrupted);
        // Spec §15: interruption is its own outcome, distinct from failure and from success.
        expect(events.at(-1)).toBe(interrupted);
        expect(events.filter(isTerminalEvent)).toHaveLength(0);

        const before = events.slice(0, events.indexOf(interrupted));
        expect(before.length).toBeGreaterThan(0);
        expect(before.every((event) => event.sessionId === subject.invocation.agentSessionId)).toBe(
          true
        );
        expect(interrupted.evidenceDigests.length).toBeGreaterThan(0);
      } finally {
        await subject.dispose();
      }
    });
  });
};
