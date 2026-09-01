import { GitHubRequestError } from "../errors.js";
import type { GitHubAuthDescription, GitHubAuthStrategy } from "./types.js";

// GitHub's own token prefixes. GitHub has added new ones over time (most recently
// "github_pat_"), so an unrecognised prefix is not an error -- see describeTokenShape below.
const KNOWN_TOKEN_PREFIX_PATTERN = /^(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)/;

const describeTokenShape = (token: string): string => {
  const match = KNOWN_TOKEN_PREFIX_PATTERN.exec(token);
  if (match === null) return `unknown-prefix(${token.length})`;
  return `${match[1]}…(${token.length})`;
};

export interface CreateUserTokenAuthOptions {
  readonly readToken: () => Promise<string>;
}

/**
 * GitHub "user token" auth (personal access token / OAuth token), using GitHub's `token
 * <value>` Authorization scheme.
 *
 * `readToken` is re-invoked on every `authorization()` call rather than cached here: the live
 * test suite sources it from `gh auth token` at call time, and the underlying token can be
 * rotated or revoked out from under a long-lived process. Re-reading on every call is the only
 * way a fresh token -- including one minted after a prior call reported expiry -- ever takes
 * effect, and it removes the need for a separate `invalidate()` method: there is no cached
 * value here to invalidate.
 */
export const createUserTokenAuth = (options: CreateUserTokenAuthOptions): GitHubAuthStrategy => {
  let lastTokenShape = "unknown-prefix(0)";

  const authorization = async (): Promise<string> => {
    // Trim before use, not merely before the emptiness check. `gh auth token` terminates its
    // output with a newline, and a raw CR/LF inside an Authorization value is a header-injection
    // shape: at best undici rejects it with a confusing error, at worst a less strict client
    // splits the header. A token never carries meaningful surrounding whitespace, so normalising
    // here — rather than trusting every caller's readToken to have done it — is the safe default.
    const token = (await options.readToken()).trim();
    if (token === "") {
      throw new GitHubRequestError(
        "GitHub user token is empty or whitespace-only; cannot authenticate.",
        401,
        "unauthenticated",
        false
      );
    }
    lastTokenShape = describeTokenShape(token);
    return `token ${token}`;
  };

  const describe = (): GitHubAuthDescription => ({
    kind: "user_token",
    subject: lastTokenShape
  });

  return { kind: "user_token", authorization, describe };
};
