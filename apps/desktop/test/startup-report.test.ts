import { describe, expect, it } from "vitest";

import {
  MAXIMUM_STARTUP_CAUSE_LINKS,
  describeError,
  formatStartupFailure,
  startupFailureChain
} from "../src/utility/startup-report.js";

/** Shaped like the credentials `KNOWN_CREDENTIAL_SPECS` recognizes. */
const CREDENTIAL = `ghp_${"a".repeat(36)}`;

const owned = (message: string, code?: string, cause?: unknown): Error => {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = "GitClientError";
  if (code !== undefined) Object.defineProperty(error, "code", { value: code });
  return error;
};

describe("startup failure report", () => {
  it("keeps a short single-line message with its code and stack", () => {
    const link = describeError(owned("The Git executable is unsafe.", "unsafe_git_executable"));

    expect(link.name).toBe("GitClientError");
    expect(link.message).toBe("The Git executable is unsafe.");
    expect(link.code).toBe("unsafe_git_executable");
    expect(link.stack).toContain("GitClientError");
  });

  it("scrubs a credential-shaped message instead of printing it", () => {
    const link = describeError(owned(`bootstrap rejected: ${CREDENTIAL}`));

    expect(link.message).toBeNull();
    expect(link.stack).toBeNull();
    expect(JSON.stringify(link)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(link)).not.toContain("ghp_");
  });

  it("suppresses a multi-line issue dump carrying a bootstrap payload", () => {
    const dump = new Error(
      `[\n  {\n    "path": ["hostToken"],\n    "received": "${CREDENTIAL}",\n    "dataDirectory": "/private/state"\n  }\n]`
    );
    dump.name = "ZodError";

    const link = describeError(dump);

    expect(link.name).toBe("ZodError");
    expect(link.message).toBeNull();
    expect(link.stack).toBeNull();
    expect(JSON.stringify(link)).not.toContain("hostToken");
    expect(JSON.stringify(link)).not.toContain(CREDENTIAL);
  });

  it("suppresses an over-long message that no reader would use anyway", () => {
    expect(describeError(new Error("x".repeat(4_096))).message).toBeNull();
  });

  it("keeps a syscall code and its single-line message", () => {
    const error = new Error("ENOENT: no such file or directory, realpath '/build/runtime/native'");
    Object.defineProperty(error, "code", { value: "ENOENT" });

    const link = describeError(error);

    expect(link.code).toBe("ENOENT");
    expect(link.message).toContain("ENOENT");
  });

  it("rejects a code that is not a short identifier", () => {
    const error = new Error("failed");
    Object.defineProperty(error, "code", { value: `weird ${CREDENTIAL}` });

    expect(describeError(error).code).toBeNull();
  });

  it("falls back for a value that is not an Error", () => {
    expect(describeError("boom")).toEqual({
      name: "UnknownError",
      message: null,
      code: null,
      stack: null
    });
    expect(describeError(undefined).name).toBe("UnknownError");
  });

  it("walks the cause chain in order", () => {
    const chain = startupFailureChain(
      owned("outer", "unsafe_state", owned("middle", "unsafe_state", owned("inner", "closed")))
    );

    expect(chain.map((link) => link.message)).toEqual(["outer", "middle", "inner"]);
  });

  it("stops at the link cap", () => {
    let error = owned("deepest");
    for (let index = 0; index < 40; index += 1) error = owned(`link-${index}`, undefined, error);

    expect(startupFailureChain(error)).toHaveLength(MAXIMUM_STARTUP_CAUSE_LINKS);
  });

  it("stops on a cyclic chain instead of spinning", () => {
    const first = owned("first");
    const second = owned("second", undefined, first);
    Object.defineProperty(first, "cause", { value: second, configurable: true });

    expect(startupFailureChain(first).map((link) => link.message)).toEqual(["first", "second"]);
  });

  it("formats one line of JSON that never carries the credential", () => {
    const line = formatStartupFailure(
      owned("The local runner failed closed.", "unsafe_state", new Error(`token ${CREDENTIAL}`))
    );
    const parsed = JSON.parse(line) as {
      event: string;
      message: string | null;
      code: string | null;
      causes: readonly { message: string | null }[];
    };

    expect(line).not.toContain("\n");
    expect(line).not.toContain(CREDENTIAL);
    expect(parsed.event).toBe("host_start_failed");
    expect(parsed.message).toBe("The local runner failed closed.");
    expect(parsed.code).toBe("unsafe_state");
    expect(parsed.causes[0]?.message).toBeNull();
  });

  it("formats a non-Error failure without throwing", () => {
    expect(JSON.parse(formatStartupFailure(null))).toMatchObject({
      event: "host_start_failed",
      name: "UnknownError",
      message: null
    });
  });
});
