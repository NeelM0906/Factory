import { describe, expect, it } from "vitest";

import {
  MODEL_ROUTING_FAILURE_CODES,
  ModelRoutingError,
  normalizeWorkflowFailureCode,
  WorkflowFailureSchema,
  type ModelRoutingFailureCode
} from "@autostack/contracts";

import { NATIVE_AGENT_FAILURES, NativeAgentError } from "../src/errors.js";
import {
  classifyThrowable,
  MODEL_ROUTING_FAILURE_CLASSIFICATIONS
} from "../src/failure-classification.js";

/** Distinctive substring planted in throwable messages; the table message must never carry it. */
const THROWABLE_MARKER = "THROWABLE-MESSAGE-MARKER-2fd6c0aa";

/** The six native codes T5 ships (plan Task 5 Step 2), in declaration order. */
const NATIVE_CODES = [
  "malformed_model_output",
  "model_output_unsafe",
  "native_agent_internal_error",
  "native_context_unavailable",
  "native_permission_denied",
  "native_invocation_incomplete"
] as const;

/**
 * One schema-valid `retryable` per taxonomy code: `ModelRoutingFailureSchema` pins deterministic
 * codes to false and `rate_limited` to true; only `provider_error` is caller-supplied.
 */
const VALID_RETRYABLE: Readonly<Record<ModelRoutingFailureCode, boolean>> = {
  capability_unavailable: false,
  route_disabled: false,
  provider_error: true,
  rate_limited: true,
  budget_exceeded: false
};

const routingError = (
  code: ModelRoutingFailureCode,
  retryable: boolean = VALID_RETRYABLE[code]
): ModelRoutingError =>
  new ModelRoutingError({
    schemaVersion: 1,
    code,
    message: `The router refused the request in the ${code} fixture.`,
    retryable
  });

describe("MODEL_ROUTING_FAILURE_CLASSIFICATIONS", () => {
  it("is a frozen table exhaustive over MODEL_ROUTING_FAILURE_CODES, so a new taxonomy code fails here", () => {
    // Rejects the wrong implementation that lets an unlisted taxonomy code fall through to a
    // default branch: the table's key set must equal the exported const array exactly.
    expect(Object.isFrozen(MODEL_ROUTING_FAILURE_CLASSIFICATIONS)).toBe(true);
    expect(Object.keys(MODEL_ROUTING_FAILURE_CLASSIFICATIONS).sort()).toStrictEqual(
      [...MODEL_ROUTING_FAILURE_CODES].sort()
    );
    for (const code of MODEL_ROUTING_FAILURE_CODES) {
      const entry = MODEL_ROUTING_FAILURE_CLASSIFICATIONS[code];
      // The five taxonomy codes are carried through unchanged (plan Task 5 Step 2).
      expect(entry.code).toBe(code);
      expect(typeof entry.message).toBe("string");
      expect(entry.message.length).toBeGreaterThan(0);
    }
  });

  it("classifies every ModelRoutingError to its table entry with the code carried through unchanged", () => {
    for (const code of MODEL_ROUTING_FAILURE_CODES) {
      const failure = classifyThrowable(routingError(code));
      expect(failure.code).toBe(code);
      expect(failure.message).toBe(MODEL_ROUTING_FAILURE_CLASSIFICATIONS[code].message);
      expect(failure.retryable).toBe(VALID_RETRYABLE[code]);
    }
  });

  it("preserves retryable from the ModelRoutingError instead of re-deriving it from a local code-to-boolean table", () => {
    // Rejects the wrong implementation that keeps its own code-to-retryable table: for
    // provider_error the taxonomy leaves retryable caller-supplied, so two errors differing ONLY
    // in retryable must classify differently — a local table answers the same for both.
    const transient = classifyThrowable(routingError("provider_error", true));
    const permanent = classifyThrowable(routingError("provider_error", false));
    expect(transient.retryable).toBe(true);
    expect(permanent.retryable).toBe(false);
    // Positive companion: everything except retryable is identical.
    expect(transient.code).toBe(permanent.code);
    expect(transient.message).toBe(permanent.message);
  });

  it("keeps every code distinct from its message across both tables", () => {
    // Companion to the conformance suite's `code !== message` rule: a table entry whose message
    // merely restates its code would pass a shape check but fail here.
    for (const code of MODEL_ROUTING_FAILURE_CODES) {
      const entry = MODEL_ROUTING_FAILURE_CLASSIFICATIONS[code];
      expect(entry.code).not.toBe(entry.message);
    }
    for (const code of NATIVE_CODES) {
      expect(NATIVE_AGENT_FAILURES[code].message).not.toBe(code);
    }
  });
});

describe("workflow-failure round-trips", () => {
  it("round-trips every native and carried code through normalizeWorkflowFailureCode unchanged", () => {
    const carriedCodes = MODEL_ROUTING_FAILURE_CODES.map(
      (code) => MODEL_ROUTING_FAILURE_CLASSIFICATIONS[code].code
    );
    for (const code of [...NATIVE_CODES, ...carriedCodes]) {
      // Never undefined, never rewritten: unchanged-acceptance is the shared rule.
      expect(normalizeWorkflowFailureCode(code)).toBe(code);
    }
    for (const code of NATIVE_CODES) {
      const entry = NATIVE_AGENT_FAILURES[code];
      const lifted = WorkflowFailureSchema.parse({
        code,
        name: "NativeAgentError",
        message: entry.message,
        retryable: entry.retryable
      });
      expect(lifted.code).toBe(code);
    }
    for (const code of MODEL_ROUTING_FAILURE_CODES) {
      const entry = MODEL_ROUTING_FAILURE_CLASSIFICATIONS[code];
      const lifted = WorkflowFailureSchema.parse({
        code: entry.code,
        name: "ModelRoutingError",
        message: entry.message,
        retryable: VALID_RETRYABLE[code]
      });
      expect(lifted.code).toBe(entry.code);
    }
  });

  it("rejects a leading-space candidate instead of trimming it into acceptance", () => {
    // Rejects the wrong implementation that normalizes (trims) a candidate code before lookup:
    // WorkflowFailureCodeSchema carries .trim(), so " rate_limited" parses successfully to a
    // DIFFERENT string, and trim-then-accept would conjure a code the stream never carried.
    expect(normalizeWorkflowFailureCode(" rate_limited")).toBeUndefined();
    expect(Object.hasOwn(MODEL_ROUTING_FAILURE_CLASSIFICATIONS, " rate_limited")).toBe(false);
    // Positive companions, same run: the untrimmed code is accepted everywhere.
    expect(normalizeWorkflowFailureCode("rate_limited")).toBe("rate_limited");
    expect(Object.hasOwn(MODEL_ROUTING_FAILURE_CLASSIFICATIONS, "rate_limited")).toBe(true);
    // A forged throwable duck-typed to look like a routing error with a spaced code must fall to
    // the internal-error classification, never be trimmed into the rate_limited entry.
    const forged = {
      name: "ModelRoutingError",
      code: " rate_limited",
      retryable: true,
      message: "forged"
    };
    const failure = classifyThrowable(forged);
    expect(failure.code).toBe("native_agent_internal_error");
    expect(failure.retryable).toBe(false);
  });
});

describe("classifyThrowable on non-ModelRoutingError throwables", () => {
  it("classifies as native_agent_internal_error with the table message, never the throwable's", () => {
    // Rejects the wrong implementation that copies the throwable's (untrusted) message into the
    // surfaced failure instead of drawing the message from the frozen table.
    const throwable = new Error(`boom ${THROWABLE_MARKER}`);
    const failure = classifyThrowable(throwable);
    expect(failure.code).toBe("native_agent_internal_error");
    expect(failure.retryable).toBe(false);
    // Positive companion: the message is exactly the table's entry...
    expect(failure.message).toBe(NATIVE_AGENT_FAILURES.native_agent_internal_error.message);
    // ...and therefore never carries the throwable's marker.
    expect(failure.message).not.toContain(THROWABLE_MARKER);
  });

  it("attaches the original throwable as a non-enumerable cause", () => {
    // Rejects the wrong implementation that either drops the original (no cause) or attaches it
    // enumerably, where JSON.stringify and enumeration would leak it downstream.
    const throwable = new Error(`boom ${THROWABLE_MARKER}`);
    const failure = classifyThrowable(throwable);
    const descriptor = Object.getOwnPropertyDescriptor(failure, "cause");
    expect(descriptor).toBeDefined();
    expect(descriptor?.value).toBe(throwable);
    expect(descriptor?.enumerable).toBe(false);
    expect(Object.keys(failure)).not.toContain("cause");
    expect(JSON.stringify(failure)).not.toContain(THROWABLE_MARKER);
    // Non-Error throwables (a thrown string) ride the same channel.
    const stringy = classifyThrowable(`kaboom ${THROWABLE_MARKER}`);
    expect(stringy.code).toBe("native_agent_internal_error");
    expect(stringy.message).not.toContain(THROWABLE_MARKER);
    expect(Object.getOwnPropertyDescriptor(stringy, "cause")?.value).toBe(
      `kaboom ${THROWABLE_MARKER}`
    );
  });
});

describe("NATIVE_AGENT_FAILURES and NativeAgentError", () => {
  it("declares exactly the six native codes in a frozen table with prose messages", () => {
    expect(Object.isFrozen(NATIVE_AGENT_FAILURES)).toBe(true);
    expect(Object.keys(NATIVE_AGENT_FAILURES).sort()).toStrictEqual([...NATIVE_CODES].sort());
    for (const code of NATIVE_CODES) {
      const entry = NATIVE_AGENT_FAILURES[code];
      expect(typeof entry.message).toBe("string");
      expect(entry.message.length).toBeGreaterThan(0);
      expect(typeof entry.retryable).toBe("boolean");
    }
    // The plan pins these two: malformed output and internal errors never invite a retry.
    expect(NATIVE_AGENT_FAILURES.malformed_model_output.retryable).toBe(false);
    expect(NATIVE_AGENT_FAILURES.native_agent_internal_error.retryable).toBe(false);
  });

  it("raises NativeAgentError with code, message, and retryable drawn only from the table", () => {
    // Mirrors agent-runtime's AgentRuntimeError discipline: no caller-supplied provenance can be
    // smuggled into the surfaced failure, and the cause stays non-enumerable.
    const error = new NativeAgentError("native_permission_denied");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("NativeAgentError");
    expect(error.code).toBe("native_permission_denied");
    expect(error.message).toBe(NATIVE_AGENT_FAILURES.native_permission_denied.message);
    expect(error.retryable).toBe(NATIVE_AGENT_FAILURES.native_permission_denied.retryable);
    expect(Object.isFrozen(error)).toBe(true);
    const cause = new Error(`inner ${THROWABLE_MARKER}`);
    const wrapped = new NativeAgentError("native_agent_internal_error", cause);
    expect(wrapped.message).toBe(NATIVE_AGENT_FAILURES.native_agent_internal_error.message);
    expect(wrapped.message).not.toContain(THROWABLE_MARKER);
    const descriptor = Object.getOwnPropertyDescriptor(wrapped, "cause");
    expect(descriptor?.value).toBe(cause);
    expect(descriptor?.enumerable).toBe(false);
  });
});
