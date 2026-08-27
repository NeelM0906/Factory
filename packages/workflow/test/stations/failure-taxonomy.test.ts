import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ModelRoutingError, WorkflowFailureSchema } from "@autostack/contracts";
import {
  ApprovalDecisionConflictError,
  IneligibleApproverError,
  InvalidRunTransitionError,
  LeaseConflictError,
  OptimisticConcurrencyError,
  StaleApprovalEvidenceError
} from "@autostack/domain";

import { classifyStageFailure } from "../../src/stations/failure-taxonomy.js";

const expectValid = (failure: ReturnType<typeof classifyStageFailure>): void => {
  expect(WorkflowFailureSchema.safeParse(failure).success).toBe(true);
};

const routingError = (code: string, retryable: boolean): ModelRoutingError =>
  new ModelRoutingError({ schemaVersion: 1, code, message: "Routing failed.", retryable });

describe("classifyStageFailure", () => {
  describe("ModelRoutingError", () => {
    it.each([
      ["rate_limited", true],
      ["capability_unavailable", false],
      ["route_disabled", false],
      ["budget_exceeded", false]
    ] as const)("reads code %s with retryable=%s verbatim, never re-derived", (code, retryable) => {
      const failure = classifyStageFailure(routingError(code, retryable));
      expect(failure.code).toBe(code);
      expect(failure.retryable).toBe(retryable);
      expectValid(failure);
    });

    it.each([true, false] as const)(
      "asserts provider_error round-trips retryable=%s unchanged, since it is legitimately either",
      (retryable) => {
        const failure = classifyStageFailure(routingError("provider_error", retryable));
        expect(failure.code).toBe("provider_error");
        expect(failure.retryable).toBe(retryable);
        expectValid(failure);
      }
    );
  });

  describe("agent-session failures", () => {
    it.each([
      ["network_timeout", true],
      ["sandbox_denied", false]
    ] as const)("normalizes a well-formed harness code %s unchanged", (code, retryable) => {
      const failure = classifyStageFailure({ type: "failed", code, retryable, message: "boom" });
      expect(failure.code).toBe(code);
      expect(failure.retryable).toBe(retryable);
      expectValid(failure);
    });

    it.each(["-32601", "provider.rate_limited", "RATE_LIMITED", " rate_limited", ""])(
      "fails closed to agent_error/false for a code that does not survive normalization unchanged: %j",
      (code) => {
        const failure = classifyStageFailure({
          type: "failed",
          code,
          retryable: true,
          message: "x"
        });
        expect(failure.code).toBe("agent_error");
        expect(failure.retryable).toBe(false);
        expectValid(failure);
      }
    );

    it("truncates an overlong agent-session message to 2000 characters", () => {
      const failure = classifyStageFailure({
        type: "failed",
        code: "network_timeout",
        retryable: true,
        message: "x".repeat(3_000)
      });
      expect(failure.message.length).toBe(2_000);
      expectValid(failure);
    });

    it("redacts credential-shaped text out of an agent-session message", () => {
      const secret = `ghp_${"A".repeat(24)}`;
      const failure = classifyStageFailure({
        type: "failed",
        code: "network_timeout",
        retryable: true,
        message: `token leaked: ${secret}`
      });
      expect(failure.message).not.toContain(secret);
      expectValid(failure);
    });
  });

  describe("domain errors", () => {
    it("maps LeaseConflictError to lease_conflict/true", () => {
      const failure = classifyStageFailure(new LeaseConflictError("job_1"));
      expect(failure.code).toBe("lease_conflict");
      expect(failure.retryable).toBe(true);
      expectValid(failure);
    });

    it("maps OptimisticConcurrencyError to version_conflict/true", () => {
      const failure = classifyStageFailure(new OptimisticConcurrencyError("stream_1", 1, 2));
      expect(failure.code).toBe("version_conflict");
      expect(failure.retryable).toBe(true);
      expectValid(failure);
    });

    it("maps StaleApprovalEvidenceError to stale_approval_evidence/false", () => {
      const failure = classifyStageFailure(new StaleApprovalEvidenceError());
      expect(failure.code).toBe("stale_approval_evidence");
      expect(failure.retryable).toBe(false);
      expectValid(failure);
    });

    it("maps IneligibleApproverError to ineligible_approver/false", () => {
      const failure = classifyStageFailure(new IneligibleApproverError("actor_1"));
      expect(failure.code).toBe("ineligible_approver");
      expect(failure.retryable).toBe(false);
      expectValid(failure);
    });

    it("maps ApprovalDecisionConflictError to approval_decision_conflict/false", () => {
      const failure = classifyStageFailure(new ApprovalDecisionConflictError());
      expect(failure.code).toBe("approval_decision_conflict");
      expect(failure.retryable).toBe(false);
      expectValid(failure);
    });

    it("maps InvalidRunTransitionError to invalid_run_transition/false", () => {
      const failure = classifyStageFailure(new InvalidRunTransitionError("triaging", "completed"));
      expect(failure.code).toBe("invalid_run_transition");
      expect(failure.retryable).toBe(false);
      expectValid(failure);
    });

    it("maps a ZodError to invalid_input/false", () => {
      const result = z.object({ name: z.string() }).strict().safeParse({});
      if (result.success) throw new Error("expected the schema to reject an empty object");
      const failure = classifyStageFailure(result.error);
      expect(failure.code).toBe("invalid_input");
      expect(failure.retryable).toBe(false);
      expectValid(failure);
    });
  });

  describe("unknown failures", () => {
    it.each([
      ["a plain string", "boom"],
      ["a number", 42],
      ["null", null],
      ["undefined", undefined],
      ["a plain object", { message: "boom" }],
      ["a generic Error not in the taxonomy", new Error("boom")]
    ])("maps %s to unknown_error/false", (_label, value) => {
      const failure = classifyStageFailure(value);
      expect(failure.code).toBe("unknown_error");
      expect(failure.retryable).toBe(false);
      expectValid(failure);
    });
  });
});
