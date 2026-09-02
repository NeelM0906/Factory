import type { ZodType } from "zod";

import { containsSensitiveMaterial } from "@autostack/contracts";

import { NATIVE_AGENT_FAILURES, type NativeAgentFailure } from "./errors.js";

/** Re-asks allowed after an admission failure. 0 or 1; the policy is a ceiling, not a loop. */
export interface StructuredOutputPolicy {
  readonly maxRepairAttempts: 0 | 1;
}

export type StructuredOutputOutcome<T> =
  | { readonly kind: "admitted"; readonly value: T; readonly attempts: number }
  | { readonly kind: "rejected"; readonly failure: NativeAgentFailure; readonly attempts: number };

export interface StructuredOutputRequest<T> {
  readonly role: string;
  readonly schema: ZodType<T>;
  /** The initial model response text (untrusted). */
  readonly responseText: string;
  readonly policy: StructuredOutputPolicy;
  /** Performs the one permitted re-ask, carrying the failed schema paths; returns new text. */
  readonly reask: (schemaPaths: readonly string[]) => Promise<string>;
}

/** Label used for a Zod issue whose path is empty (an issue on the object itself). */
const ROOT_PATH_LABEL = "(root)";

/**
 * Strips a single markdown fence wrapping the whole (trimmed) response. Fences elsewhere are
 * left alone; the balanced scan below never mistakes backticks for structure anyway.
 */
const stripFence = (text: string): string => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```") || !trimmed.endsWith("```")) {
    return trimmed;
  }
  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline === -1) {
    return trimmed;
  }
  return trimmed.slice(firstNewline + 1, trimmed.length - 3).trim();
};

/**
 * Scans forward from an opening brace, honouring JSON string and escape state, and returns the
 * index of the matching closing brace — or undefined when the object never closes.
 */
const scanBalancedObject = (text: string, start: number): number | undefined => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
};

interface ObjectSpan {
  readonly start: number;
  readonly end: number;
}

interface ObjectScan {
  readonly spans: readonly ObjectSpan[];
  /** Position of an opening brace that never closed, when the scan ended inside one. */
  readonly danglingOpenAt: number | undefined;
}

/** Collects every complete top-level `{...}` span in the text, in order. */
const scanTopLevelObjects = (text: string): ObjectScan => {
  const spans: ObjectSpan[] = [];
  let index = 0;
  while (index < text.length) {
    if (text.charAt(index) === "{") {
      const end = scanBalancedObject(text, index);
      if (end === undefined) {
        return { spans, danglingOpenAt: index };
      }
      spans.push({ start: index, end });
      index = end + 1;
    } else {
      index += 1;
    }
  }
  return { spans, danglingOpenAt: undefined };
};

/** Joined, de-duplicated Zod issue paths — locations only, never the offending values. */
const failedSchemaPaths = (
  issues: readonly { readonly path: readonly PropertyKey[] }[]
): readonly string[] => {
  const paths: string[] = [];
  for (const issue of issues) {
    const joined = issue.path.map((segment) => String(segment)).join(".");
    const label = joined === "" ? ROOT_PATH_LABEL : joined;
    if (!paths.includes(label)) {
      paths.push(label);
    }
  }
  return Object.freeze(paths);
};

/** Recursively collects every string in the admitted value (keys included) for the safety sweep. */
const collectStrings = (value: unknown, collected: string[]): void => {
  if (typeof value === "string") {
    collected.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, collected);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      collected.push(key);
      collectStrings(entry, collected);
    }
  }
};

const rejection = (
  code: "malformed_model_output" | "model_output_unsafe",
  message: string,
  schemaPaths?: readonly string[]
): NativeAgentFailure => {
  const entry = NATIVE_AGENT_FAILURES[code];
  const base = { code, message, retryable: entry.retryable };
  return Object.freeze(
    schemaPaths === undefined ? base : { ...base, schemaPaths: Object.freeze([...schemaPaths]) }
  );
};

type AdmissionResult<T> =
  | { readonly kind: "admitted"; readonly value: T }
  | { readonly kind: "rejected"; readonly failure: NativeAgentFailure; readonly terminal: boolean };

/**
 * One admission pass: extract exactly one JSON object, parse it, admit it through the schema,
 * then sweep the admitted strings for credential-shaped material. Failure messages name the role
 * and a numeric parse position — never the model's raw text or any offending value, both of
 * which are untrusted and may be enormous.
 */
const admitOnce = <T>(
  role: string,
  schema: ZodType<T>,
  responseText: string
): AdmissionResult<T> => {
  const text = stripFence(responseText);
  const scan = scanTopLevelObjects(text);
  if (scan.spans.length === 0) {
    const position = scan.danglingOpenAt ?? text.length;
    return {
      kind: "rejected",
      terminal: false,
      failure: rejection(
        "malformed_model_output",
        `Structured output for the ${role} role contained no complete JSON object (scanned to position ${position}).`
      )
    };
  }
  if (scan.spans.length > 1) {
    const second = scan.spans[1];
    const position = second === undefined ? text.length : second.start;
    return {
      kind: "rejected",
      terminal: false,
      failure: rejection(
        "malformed_model_output",
        `Structured output for the ${role} role contained ${scan.spans.length} top-level JSON objects; refusing to guess which was meant (second begins at position ${position}).`
      )
    };
  }
  const span = scan.spans[0];
  if (span === undefined) {
    // Unreachable given the length checks above; kept for noUncheckedIndexedAccess honesty.
    return {
      kind: "rejected",
      terminal: false,
      failure: rejection(
        "malformed_model_output",
        `Structured output for the ${role} role contained no complete JSON object (scanned to position 0).`
      )
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(span.start, span.end + 1));
  } catch {
    // The engine's message can quote source text; compose our own position-only message.
    return {
      kind: "rejected",
      terminal: false,
      failure: rejection(
        "malformed_model_output",
        `Structured output for the ${role} role failed to parse as JSON (object begins at position ${span.start}).`
      )
    };
  }
  const admission = schema.safeParse(parsed);
  if (!admission.success) {
    const paths = failedSchemaPaths(admission.error.issues);
    return {
      kind: "rejected",
      terminal: false,
      failure: rejection(
        "malformed_model_output",
        `Structured output for the ${role} role failed schema admission at ${paths.length} path(s): ${paths.join(", ")}.`,
        paths
      )
    };
  }
  const strings: string[] = [];
  collectStrings(admission.data, strings);
  if (strings.some((candidate) => containsSensitiveMaterial(candidate))) {
    // Terminal: refused outright, never sanitized into acceptance and never re-asked with the
    // credential-shaped material still in flight.
    return {
      kind: "rejected",
      terminal: true,
      failure: rejection(
        "model_output_unsafe",
        `Structured output for the ${role} role carried credential-shaped material and was refused.`
      )
    };
  }
  return { kind: "admitted", value: admission.data };
};

/**
 * Admits a model response as schema-valid structured output, or rejects it as a value — this
 * function never throws for malformed output. At most `policy.maxRepairAttempts` re-asks are
 * issued (the inference-call meter tests count), each carrying the failed schema paths.
 */
export const admitStructuredOutput = async <T>(
  request: StructuredOutputRequest<T>
): Promise<StructuredOutputOutcome<T>> => {
  const { role, schema, policy, reask } = request;
  let text = request.responseText;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const result = admitOnce(role, schema, text);
    if (result.kind === "admitted") {
      return { kind: "admitted", value: result.value, attempts };
    }
    if (result.terminal || attempts > policy.maxRepairAttempts) {
      return { kind: "rejected", failure: result.failure, attempts };
    }
    text = await reask(result.failure.schemaPaths ?? []);
  }
};
