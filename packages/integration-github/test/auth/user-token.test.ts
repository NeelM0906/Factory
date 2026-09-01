import { describe, expect, it, vi } from "vitest";

import { createUserTokenAuth } from "../../src/auth/user-token.js";
import { GitHubRequestError } from "../../src/errors.js";

describe("createUserTokenAuth", () => {
  it("returns the GitHub user-token scheme built from readToken()", async () => {
    const token = `gho_${"a".repeat(36)}`;
    const readToken = vi.fn(async () => token);
    const auth = createUserTokenAuth({ readToken });

    const authorization = await auth.authorization();

    expect(authorization).toBe(`token ${token}`);
    expect(auth.kind).toBe("user_token");
    expect(readToken).toHaveBeenCalledTimes(1);
  });

  it("describes the token's shape only -- prefix plus length -- never the value", async () => {
    const token = `gho_${"b".repeat(36)}`;
    const auth = createUserTokenAuth({ readToken: async () => token });

    await auth.authorization();
    const description = auth.describe();

    expect(description.kind).toBe("user_token");
    expect(description.subject).toBe(`gho_…(${token.length})`);
    expect(description.subject).not.toContain(token);
    expect(JSON.stringify(description)).not.toContain(token);
  });

  it("re-reads the token on every authorization() call, so a rotated token takes effect immediately", async () => {
    let issued = 0;
    const readToken = vi.fn(async () => {
      issued += 1;
      return `gho_token-${issued}-${"x".repeat(20)}`;
    });
    const auth = createUserTokenAuth({ readToken });

    const first = await auth.authorization();
    const second = await auth.authorization();

    expect(readToken).toHaveBeenCalledTimes(2);
    expect(first).toBe(`token gho_token-1-${"x".repeat(20)}`);
    expect(second).toBe(`token gho_token-2-${"x".repeat(20)}`);
    expect(first).not.toBe(second);
  });

  it("fails closed with unauthenticated on an empty token, leaking no token material", async () => {
    const auth = createUserTokenAuth({ readToken: async () => "" });

    const failure = await auth.authorization().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubRequestError);
    expect((failure as GitHubRequestError).code).toBe("unauthenticated");
    expect((failure as GitHubRequestError).retryable).toBe(false);
  });

  it("fails closed with unauthenticated on a whitespace-only token", async () => {
    const whitespaceToken = "   \t  ";
    const auth = createUserTokenAuth({ readToken: async () => whitespaceToken });

    const failure = await auth.authorization().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubRequestError);
    expect((failure as GitHubRequestError).code).toBe("unauthenticated");
    expect((failure as GitHubRequestError).message).not.toContain(whitespaceToken);
  });

  it("trims surrounding whitespace so a gh-auth-token newline cannot reach the header", async () => {
    // `gh auth token` terminates its output with a newline. A raw CR/LF inside an Authorization
    // value is a header-injection shape, so the strategy must normalise rather than trust the
    // caller's readToken to have trimmed.
    // Built at runtime so the source blob never contains a scannable token shape — a literal
    // matching GitHub's real gho_ pattern is indistinguishable from a leak to secret scanners.
    const token = ["gho", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
    const auth = createUserTokenAuth({ readToken: async () => `  ${token}\r\n` });

    const authorization = await auth.authorization();

    expect(authorization).toBe(`token ${token}`);
    expect(authorization).not.toContain("\n");
    expect(authorization).not.toContain("\r");
    // The shape description must measure the real token, not the whitespace-padded input.
    expect(auth.describe().subject).toBe(`gho_…(${token.length})`);
  });

  it("does not throw on an unrecognised token prefix and describes it as unknown-prefix(<length>)", async () => {
    const token = `custom_scheme_${"z".repeat(20)}`;
    const auth = createUserTokenAuth({ readToken: async () => token });

    const authorization = await auth.authorization();
    const description = auth.describe();

    expect(authorization).toBe(`token ${token}`);
    expect(description.subject).toBe(`unknown-prefix(${token.length})`);
  });
});
