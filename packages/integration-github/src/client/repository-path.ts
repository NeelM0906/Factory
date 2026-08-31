import { GitHubRequestError } from "../errors.js";

const REPOSITORY_FULL_NAME_PATTERN = /^[^/\s]+\/[^/\s]+$/;

/**
 * Splits and validates `owner/repo`, then URL-encodes each segment SEPARATELY
 * (`encodeURIComponent(owner)` / `encodeURIComponent(repo)`). This is deliberate: calling
 * `encodeURI` (or any encoding) on the joined string would leave a literal "/" inside a segment
 * unescaped, letting it traverse the API path. `REPOSITORY_FULL_NAME_PATTERN` already forbids a
 * "/" inside either segment, but per-segment encoding keeps the property structurally true
 * regardless of how that pattern evolves.
 *
 * Consolidated here in Task 9: `branch-refs.ts`, `pull-requests.ts`, `progress-comments.ts`, and
 * `checks.ts` each carried their own copy of this exact function, because the earlier tasks that
 * added the latter three were forbidden from touching `branch-refs.ts` while it and they landed in
 * parallel. This is a pure extraction -- behaviour is unchanged from every prior copy.
 */
export const encodeRepositoryPath = (repositoryFullName: string): string => {
  if (!REPOSITORY_FULL_NAME_PATTERN.test(repositoryFullName)) {
    throw new GitHubRequestError(
      `Repository full name "${repositoryFullName}" is not a valid "owner/repo" pair.`,
      0,
      "invalid_request",
      false
    );
  }
  const slashIndex = repositoryFullName.indexOf("/");
  const owner = repositoryFullName.slice(0, slashIndex);
  const repo = repositoryFullName.slice(slashIndex + 1);
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
};
