import { redactSensitiveText } from "@autostack/contracts";

/**
 * One link of a startup failure's cause chain, reduced to what is safe to print.
 *
 * The daemon's boundary errors are stable by design -- "The local runner failed closed." names no
 * layer -- so a startup failure is only diagnosable through its causes. Those causes are not
 * curated: a Zod rejection of the bootstrap payload carries the host token and data directory in
 * its issue dump, and a syscall error carries paths. Printing them raw is the leak this shape
 * exists to prevent.
 */
export interface StartupFailureLink {
  readonly name: string;
  readonly message: string | null;
  readonly code: string | null;
  readonly stack: string | null;
}

export const MAXIMUM_STARTUP_CAUSE_LINKS = 8;

const MAXIMUM_NAME_CHARACTERS = 64;
const MAXIMUM_MESSAGE_CHARACTERS = 512;
const MAXIMUM_STACK_CHARACTERS = 4_096;

/** Error codes in this workspace are short identifiers; anything else is caller-shaped. */
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

/**
 * Publishable text is text that survives redaction unchanged and stays within bounds.
 *
 * `redactSensitiveText` composes the contracts' exact-value replacement, the
 * `KNOWN_CREDENTIAL_SPECS` pattern sweep, and the streaming detector, and returns something other
 * than its input whenever any of them fire. Rather than print the redacted form -- which would
 * still disclose the shape and surrounding text of whatever tripped it -- treat any change as
 * disqualifying and fall back to the name and code alone.
 *
 * The length and newline bounds are what actually stop a Zod issue dump: a bootstrap rejection is
 * multi-line JSON far past these limits, and pattern redaction alone would not catch a bare
 * high-entropy token inside it.
 */
const publishable = (value: string, limit: number, allowNewlines: boolean): string | null => {
  if (value.length === 0 || value.length > limit) return null;
  if (!allowNewlines && /[\r\n]/u.test(value)) return null;
  return redactSensitiveText(value) === value ? value : null;
};

export const describeError = (error: unknown): StartupFailureLink => {
  if (!(error instanceof Error)) {
    return { name: "UnknownError", message: null, code: null, stack: null };
  }
  const rawCode: unknown = Reflect.get(error, "code");
  const message = publishable(error.message, MAXIMUM_MESSAGE_CHARACTERS, false);
  return {
    name: publishable(error.name, MAXIMUM_NAME_CHARACTERS, false) ?? "UnknownError",
    message,
    code: typeof rawCode === "string" && SAFE_CODE.test(rawCode) ? rawCode : null,
    // A stack opens with its own message, so it is exactly as publishable as that message was.
    stack: message === null ? null : publishable(error.stack ?? "", MAXIMUM_STACK_CHARACTERS, true)
  };
};

export const startupFailureChain = (error: unknown): readonly StartupFailureLink[] => {
  const chain: StartupFailureLink[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (
    current !== undefined &&
    current !== null &&
    chain.length < MAXIMUM_STARTUP_CAUSE_LINKS &&
    !seen.has(current)
  ) {
    seen.add(current);
    chain.push(describeError(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
};

/** One line of JSON, safe to hand to a log stream. */
export const formatStartupFailure = (error: unknown): string => {
  const chain = startupFailureChain(error);
  const head = chain[0];
  return JSON.stringify({
    level: "error",
    event: "host_start_failed",
    name: head?.name ?? "UnknownError",
    message: head?.message ?? null,
    code: head?.code ?? null,
    stack: head?.stack ?? null,
    causes: chain.slice(1)
  });
};
