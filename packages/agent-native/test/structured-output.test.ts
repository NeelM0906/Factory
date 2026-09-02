import { describe, expect, it } from "vitest";
import { z } from "zod";

import { containsSensitiveMaterial } from "@autostack/contracts";

import type { NativeAgentFailure } from "../src/errors.js";
import {
  admitStructuredOutput,
  type StructuredOutputOutcome,
  type StructuredOutputPolicy
} from "../src/structured-output.js";

/** AWS-access-key shaped: the `AKIA` + 16 upper-alphanumeric spec in KNOWN_CREDENTIAL_SPECS. */
const AWS_KEY_SHAPED = `AKIA${"A".repeat(16)}`;

/** Distinctive substring planted in raw model text; it must never surface in a failure message. */
const RAW_TEXT_MARKER = "RAW-MODEL-OUTPUT-MARKER-7c31e9d2";

/** Distinctive substring planted as an offending value; failures carry paths, never values. */
const VALUE_MARKER = "OFFENDING-VALUE-MARKER-5b8d02aa";

const ROLE = "triage";

const ReportSchema = z
  .object({
    title: z.string().min(1),
    meta: z.object({ priority: z.number().int().min(1).max(5) }).strict()
  })
  .strict();
type Report = z.infer<typeof ReportSchema>;

const VALID_REPORT: Report = { title: "Checkout regression triage", meta: { priority: 2 } };
const VALID_REPORT_TEXT = JSON.stringify(VALID_REPORT);

/** Fails `ReportSchema` at exactly one path (`meta.priority`), with the marker as the value. */
const SCHEMA_INVALID_TEXT = JSON.stringify({ title: "ok", meta: { priority: VALUE_MARKER } });

const NO_REPAIR: StructuredOutputPolicy = { maxRepairAttempts: 0 };
const ONE_REPAIR: StructuredOutputPolicy = { maxRepairAttempts: 1 };

interface ReaskScript {
  readonly calls: readonly (readonly string[])[];
  readonly reask: (schemaPaths: readonly string[]) => Promise<string>;
}

/**
 * Records every re-ask invocation (the inference-call count) and replays scripted responses.
 * When invoked past its script it answers with an empty object — schema-invalid for every suite
 * schema — so an over-eager retry loop stays observable in the call count instead of crashing.
 */
const scriptReask = (responses: readonly string[]): ReaskScript => {
  const calls: (readonly string[])[] = [];
  const reask = (schemaPaths: readonly string[]): Promise<string> => {
    const scripted = responses[calls.length];
    calls.push([...schemaPaths]);
    return Promise.resolve(scripted ?? "{}");
  };
  return { calls, reask };
};

const expectAdmitted = <T>(
  outcome: StructuredOutputOutcome<T>
): { readonly value: T; readonly attempts: number } => {
  if (outcome.kind !== "admitted") {
    throw new Error(`Expected an admitted outcome, received "${outcome.kind}".`);
  }
  return outcome;
};

const expectRejected = <T>(
  outcome: StructuredOutputOutcome<T>
): { readonly failure: NativeAgentFailure; readonly attempts: number } => {
  if (outcome.kind !== "rejected") {
    throw new Error(`Expected a rejected outcome, received "${outcome.kind}".`);
  }
  return outcome;
};

describe("admitStructuredOutput", () => {
  it("admits well-formed JSON matching the schema on attempt 1 without re-asking", async () => {
    const script = scriptReask([]);
    const outcome = await admitStructuredOutput({
      role: ROLE,
      schema: ReportSchema,
      responseText: VALID_REPORT_TEXT,
      policy: NO_REPAIR,
      reask: script.reask
    });
    const admitted = expectAdmitted(outcome);
    expect(admitted.value).toStrictEqual(VALID_REPORT);
    expect(admitted.attempts).toBe(1);
    expect(script.calls).toHaveLength(0);
  });

  it("rejects non-JSON text with malformed_model_output naming the role and parse position, never the raw text", async () => {
    // Rejects the wrong implementation that quotes the model's raw (untrusted, possibly enormous)
    // text into the failure message instead of reporting only the role and the parse position.
    const script = scriptReask([]);
    const outcome = await admitStructuredOutput({
      role: ROLE,
      schema: ReportSchema,
      responseText: `The model rambled ${RAW_TEXT_MARKER} and produced no JSON at all.`,
      policy: NO_REPAIR,
      reask: script.reask
    });
    const rejected = expectRejected(outcome);
    expect(rejected.failure.code).toBe("malformed_model_output");
    expect(rejected.failure.retryable).toBe(false);
    expect(rejected.attempts).toBe(1);
    expect(script.calls).toHaveLength(0);
    // Positive companions: the message does name the role and a parse position...
    expect(rejected.failure.message).toContain(ROLE);
    expect(rejected.failure.message).toMatch(/position/i);
    expect(rejected.failure.message).toMatch(/\d/);
    // ...while the raw model text stays out of it.
    expect(rejected.failure.message).not.toContain(RAW_TEXT_MARKER);
  });

  it("rejects schema-invalid JSON carrying the failed schema paths, never the offending values", async () => {
    // Rejects the wrong implementation that embeds the offending values (untrusted model output)
    // in the failure instead of only the joined issue paths.
    const script = scriptReask([]);
    const outcome = await admitStructuredOutput({
      role: ROLE,
      schema: ReportSchema,
      responseText: SCHEMA_INVALID_TEXT,
      policy: NO_REPAIR,
      reask: script.reask
    });
    const rejected = expectRejected(outcome);
    expect(rejected.failure.code).toBe("malformed_model_output");
    expect(rejected.failure.retryable).toBe(false);
    // Positive companion: the failure carries exactly the joined path that failed.
    expect(rejected.failure.schemaPaths).toStrictEqual(["meta.priority"]);
    expect(rejected.failure.message).toContain(ROLE);
    expect(rejected.failure.message).not.toContain(VALUE_MARKER);
    for (const path of rejected.failure.schemaPaths ?? []) {
      expect(path).not.toContain(VALUE_MARKER);
    }
  });

  it("admits a response wrapped in a markdown fence after fence stripping", async () => {
    const script = scriptReask([]);
    const outcome = await admitStructuredOutput({
      role: ROLE,
      schema: ReportSchema,
      responseText: "```json\n" + VALID_REPORT_TEXT + "\n```",
      policy: NO_REPAIR,
      reask: script.reask
    });
    const admitted = expectAdmitted(outcome);
    expect(admitted.value).toStrictEqual(VALID_REPORT);
    expect(admitted.attempts).toBe(1);
    expect(script.calls).toHaveLength(0);
  });

  it("admits prose before and after a single JSON object", async () => {
    const script = scriptReask([]);
    const outcome = await admitStructuredOutput({
      role: ROLE,
      schema: ReportSchema,
      responseText:
        "Here is the triage report you asked for.\n" +
        VALID_REPORT_TEXT +
        "\nLet me know if anything else is needed.",
      policy: NO_REPAIR,
      reask: script.reask
    });
    const admitted = expectAdmitted(outcome);
    expect(admitted.value).toStrictEqual(VALID_REPORT);
    expect(admitted.attempts).toBe(1);
  });

  it("rejects a response with two top-level JSON objects instead of guessing which one the model meant", async () => {
    // Rejects the wrong implementation that guesses which object the model meant (first, last,
    // or largest): guessing is exactly the trust this discipline exists to withhold.
    const second: Report = { title: "Second guess", meta: { priority: 4 } };
    const script = scriptReask([]);
    const outcome = await admitStructuredOutput({
      role: ROLE,
      schema: ReportSchema,
      responseText: `${VALID_REPORT_TEXT}\n${JSON.stringify(second)}`,
      policy: NO_REPAIR,
      reask: script.reask
    });
    const rejected = expectRejected(outcome);
    expect(rejected.failure.code).toBe("malformed_model_output");
    expect(rejected.failure.retryable).toBe(false);
    // Positive companion, same run: either object alone is admissible.
    const single = await admitStructuredOutput({
      role: ROLE,
      schema: ReportSchema,
      responseText: JSON.stringify(second),
      policy: NO_REPAIR,
      reask: script.reask
    });
    expect(expectAdmitted(single).value).toStrictEqual(second);
  });

  it("with maxRepairAttempts 1, re-asks exactly once carrying the failed schema paths, then admits the repair", async () => {
    const script = scriptReask([VALID_REPORT_TEXT]);
    const outcome = await admitStructuredOutput({
      role: ROLE,
      schema: ReportSchema,
      responseText: SCHEMA_INVALID_TEXT,
      policy: ONE_REPAIR,
      reask: script.reask
    });
    const admitted = expectAdmitted(outcome);
    expect(admitted.value).toStrictEqual(VALID_REPORT);
    expect(admitted.attempts).toBe(2);
    expect(script.calls).toHaveLength(1);
    expect(script.calls[0]).toStrictEqual(["meta.priority"]);
  });

  it("with maxRepairAttempts 1, a second admission failure is terminal after exactly one re-ask", async () => {
    // Rejects the wrong implementation that loops silently: a retry loop issuing a second
    // (or later) re-ask fails the inference-call count below, not just the outcome shape.
    const stillInvalid = JSON.stringify({ title: "", meta: { priority: 9 } });
    const script = scriptReask([stillInvalid]);
    const outcome = await admitStructuredOutput({
      role: ROLE,
      schema: ReportSchema,
      responseText: SCHEMA_INVALID_TEXT,
      policy: ONE_REPAIR,
      reask: script.reask
    });
    const rejected = expectRejected(outcome);
    expect(rejected.failure.code).toBe("malformed_model_output");
    expect(rejected.failure.retryable).toBe(false);
    expect(rejected.attempts).toBe(2);
    expect(script.calls).toHaveLength(1);
    expect([...(rejected.failure.schemaPaths ?? [])].sort()).toStrictEqual([
      "meta.priority",
      "title"
    ]);
  });

  it("with maxRepairAttempts 0, rejects immediately without any re-ask", async () => {
    // Rejects the wrong implementation that treats the policy as advisory and re-asks anyway.
    const script = scriptReask([VALID_REPORT_TEXT]);
    const outcome = await admitStructuredOutput({
      role: ROLE,
      schema: ReportSchema,
      responseText: SCHEMA_INVALID_TEXT,
      policy: NO_REPAIR,
      reask: script.reask
    });
    const rejected = expectRejected(outcome);
    expect(rejected.failure.code).toBe("malformed_model_output");
    expect(rejected.attempts).toBe(1);
    expect(script.calls).toHaveLength(0);
  });

  it("rejects an admitted value whose string fields trip containsSensitiveMaterial with model_output_unsafe", async () => {
    // Rejects the wrong implementation that sanitizes (redacts) credential-shaped output into
    // acceptance instead of refusing it outright.
    const NoteSchema = z.object({ note: z.string().min(1) }).strict();
    expect(containsSensitiveMaterial(AWS_KEY_SHAPED)).toBe(true);
    const script = scriptReask([]);
    const outcome = await admitStructuredOutput({
      role: ROLE,
      schema: NoteSchema,
      responseText: JSON.stringify({ note: `Rotate the key ${AWS_KEY_SHAPED} before release.` }),
      policy: NO_REPAIR,
      reask: script.reask
    });
    const rejected = expectRejected(outcome);
    expect(rejected.failure.code).toBe("model_output_unsafe");
    expect(rejected.failure.retryable).toBe(false);
    // The credential must not leak into the failure message either.
    expect(rejected.failure.message).not.toContain(AWS_KEY_SHAPED);
    // Positive companion, same run: the same schema admits a benign value.
    const benign = await admitStructuredOutput({
      role: ROLE,
      schema: NoteSchema,
      responseText: JSON.stringify({ note: "Rotate the credential via the vault runbook." }),
      policy: NO_REPAIR,
      reask: script.reask
    });
    expect(expectAdmitted(benign).value).toStrictEqual({
      note: "Rotate the credential via the vault runbook."
    });
    expect(script.calls).toHaveLength(0);
  });
});
