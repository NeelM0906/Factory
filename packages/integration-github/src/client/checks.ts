import { z } from "zod";

import { assertAutoStackBranch } from "../branch-policy.js";
import { GitHubRequestError } from "../errors.js";
import type { GitHubTransport } from "./transport.js";

const REPOSITORY_FULL_NAME_PATTERN = /^[^/\s]+\/[^/\s]+$/;
const FORTY_HEX_SHA_PATTERN = /^[0-9a-f]{40}$/i;

/**
 * Splits `owner/repo` and URL-encodes each segment separately, exactly like `client/pull-
 * requests.ts` and `client/branch-refs.ts` do. Duplicated locally rather than imported: those
 * two modules (and `client/progress-comments.ts`, which duplicates it a second time) are on the
 * do-not-touch list for this task; consolidating this helper is a deliberate Task 9 cleanup.
 */
const encodeRepositoryPath = (repositoryFullName: string): string => {
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

// A branch ref may contain "/"-separated components (e.g. "autostack/issue-42"); each is
// percent-encoded independently, matching `client/branch-refs.ts`'s `encodeRefPath`, so the
// hierarchical slashes survive while every other character is safely escaped. A 40-hex SHA never
// contains a "/", so this is a no-op for that branch of `resolveCheckRunsRef`.
const encodeRefPath = (ref: string): string =>
  ref
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

/**
 * `ref` must be either a 40-hex commit SHA or an `autostack/`-prefixed branch (reusing
 * `assertAutoStackBranch`, which also normalises a `refs/heads/` prefix). Anything else -- a
 * short SHA, `main`, an arbitrary branch -- is rejected before any network I/O, matching every
 * other client in this package's "validate before the call" convention.
 */
const resolveCheckRunsRef = (ref: string): string =>
  FORTY_HEX_SHA_PATTERN.test(ref) ? ref : assertAutoStackBranch(ref);

// GitHub's check-run payload carries many more fields than this; only the ones the narrow result
// needs are modeled. Zod ignores unmodeled fields by default, so this is not `.strict()`.
const gitHubCheckRunSchema = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  details_url: z.string().nullable()
});

const gitHubCheckRunsResponseSchema = z.object({
  total_count: z.number().int().nonnegative(),
  check_runs: z.array(gitHubCheckRunSchema)
});

export interface GitHubCheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly detailsUrl: string | null;
}

export interface ListCheckRunsRequest {
  readonly repositoryFullName: string;
  readonly ref: string;
}

export interface GitHubChecksClient {
  listCheckRuns(request: ListCheckRunsRequest): Promise<readonly GitHubCheckRun[]>;
}

/**
 * Read-only check-run listing (spec §4.4): `GET /repos/{owner}/{repo}/commits/{ref}/check-runs`,
 * schema-validated into a narrow `{ name, status, conclusion, detailsUrl }[]`. This module never
 * issues a non-GET call -- there is no rerun, no re-request, no status write anywhere here.
 *
 * A red (`conclusion: "failure"`, `"cancelled"`, etc.) check run is returned as plain data, not
 * acted on. Milestone A requires an explicit user action before any repair attempt (spec §4.4);
 * that decision, and the action itself, belong to a caller above this client, not to a read
 * client. There is no behavioural difference in this module's own code path between a red and a
 * green conclusion -- both take the identical parse-and-map branch -- so beyond the "no repair
 * call is issued" guard test in `test/client/checks.test.ts`, that absence of special-casing is
 * documented here rather than asserted a second time.
 */
export const createChecksClient = (transport: GitHubTransport): GitHubChecksClient => {
  const listCheckRuns = async (
    request: ListCheckRunsRequest
  ): Promise<readonly GitHubCheckRun[]> => {
    const ref = resolveCheckRunsRef(request.ref);
    const repoPath = encodeRepositoryPath(request.repositoryFullName);

    const response = await transport.request({
      method: "GET",
      path: `/repos/${repoPath}/commits/${encodeRefPath(ref)}/check-runs`,
      schema: gitHubCheckRunsResponseSchema
    });

    return response.check_runs.map((checkRun) => ({
      name: checkRun.name,
      status: checkRun.status,
      conclusion: checkRun.conclusion,
      detailsUrl: checkRun.details_url
    }));
  };

  return { listCheckRuns };
};
