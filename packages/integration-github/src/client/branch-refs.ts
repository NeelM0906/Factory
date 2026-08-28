import { z } from "zod";

import { assertAutoStackBranch } from "../branch-policy.js";
import { GitHubBranchConflictError, GitHubRequestError } from "../errors.js";
import type { GitHubTransport } from "./transport.js";

const REPOSITORY_FULL_NAME_PATTERN = /^[^/\s]+\/[^/\s]+$/;

const invalidRequestError = (message: string): GitHubRequestError =>
  new GitHubRequestError(message, 0, "invalid_request", false);

/**
 * Splits and validates `owner/repo`, then URL-encodes each segment SEPARATELY
 * (`encodeURIComponent(owner)` / `encodeURIComponent(repo)`). This is deliberate: calling
 * `encodeURI` (or any encoding) on the joined string would leave a literal "/" inside a segment
 * unescaped, letting it traverse the API path. `REPOSITORY_FULL_NAME_PATTERN` already forbids a
 * "/" inside either segment, but per-segment encoding keeps the property structurally true
 * regardless of how that pattern evolves.
 */
const encodeRepositoryPath = (repositoryFullName: string): string => {
  if (!REPOSITORY_FULL_NAME_PATTERN.test(repositoryFullName)) {
    throw invalidRequestError(
      `Repository full name "${repositoryFullName}" is not a valid "owner/repo" pair.`
    );
  }
  const slashIndex = repositoryFullName.indexOf("/");
  const owner = repositoryFullName.slice(0, slashIndex);
  const repo = repositoryFullName.slice(slashIndex + 1);
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
};

// A validated branch name may still contain characters an unencoded URL path segment cannot
// carry safely (e.g. "#"), so each "/"-separated component is percent-encoded independently --
// exactly like the repository segments above -- while the hierarchical slashes themselves are
// preserved, matching how GitHub's ref endpoints expect a multi-level ref path.
const encodeRefPath = (branch: string): string =>
  branch
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

const gitRefResponseSchema = z.object({
  ref: z.string(),
  object: z.object({
    sha: z.string(),
    type: z.string()
  })
});

const putFileResponseSchema = z.object({
  content: z.object({ sha: z.string() }),
  commit: z.object({ sha: z.string() })
});

export interface GetRefRequest {
  readonly repositoryFullName: string;
  readonly ref: string;
}

export interface CreateBranchRequest {
  readonly repositoryFullName: string;
  readonly ref: string;
  readonly sha: string;
}

export interface DeleteBranchRequest {
  readonly repositoryFullName: string;
  readonly ref: string;
}

export interface PutFileOnBranchRequest {
  readonly repositoryFullName: string;
  readonly branch: string;
  readonly path: string;
  readonly contentUtf8: string;
  readonly message: string;
}

export interface PutFileOnBranchResult {
  readonly contentSha: string;
  readonly commitSha: string;
}

export interface GitHubBranchRefsClient {
  getRef(request: GetRefRequest): Promise<string>;
  createBranch(request: CreateBranchRequest): Promise<void>;
  deleteBranch(request: DeleteBranchRequest): Promise<void>;
  putFileOnBranch(request: PutFileOnBranchRequest): Promise<PutFileOnBranchResult>;
}

const NUL = "\0";

/**
 * `path` is rejected if it is absolute, contains a `..` path-traversal segment, contains a NUL
 * byte, or is otherwise not a plain repository-relative path. Each remaining segment is
 * percent-encoded independently before being placed in the request URL.
 */
const encodeContentsPath = (path: string): string => {
  if (path === "" || path.startsWith("/") || path.includes(NUL)) {
    throw invalidRequestError(`Path is not a valid repository-relative path.`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw invalidRequestError(`Path is not a valid repository-relative path.`);
  }
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
};

/**
 * Ref-level branch operations on the GitHub Git Data API, restricted to `autostack/`-prefixed
 * branches (decision D2: pushing commits belongs to the runner/worktree layer; this is create
 * ref / delete ref / read ref / write one file, nothing more).
 *
 * Every method calls {@link assertAutoStackBranch} BEFORE any network I/O -- this is defence in
 * depth, not caller discipline, so a non-`autostack/` ref never reaches `transport.request`.
 */
export const createBranchRefsClient = (transport: GitHubTransport): GitHubBranchRefsClient => {
  const getRef = async (request: GetRefRequest): Promise<string> => {
    const branch = assertAutoStackBranch(request.ref);
    const repoPath = encodeRepositoryPath(request.repositoryFullName);
    const result = await transport.request({
      method: "GET",
      path: `/repos/${repoPath}/git/ref/heads/${encodeRefPath(branch)}`,
      schema: gitRefResponseSchema
    });
    return result.object.sha;
  };

  const createBranch = async (request: CreateBranchRequest): Promise<void> => {
    const branch = assertAutoStackBranch(request.ref);
    const repoPath = encodeRepositoryPath(request.repositoryFullName);

    try {
      await transport.request({
        method: "POST",
        path: `/repos/${repoPath}/git/refs`,
        body: { ref: `refs/heads/${branch}`, sha: request.sha },
        schema: gitRefResponseSchema
      });
      return;
    } catch (error) {
      // GitHub answers a create for an already-existing ref with 422. A retried publish must
      // not fail on its own earlier success, so re-read the ref and compare shas -- but only
      // for a 422; every other failure (rate limit, 5xx, auth) propagates unchanged.
      if (!(error instanceof GitHubRequestError) || error.status !== 422) throw error;

      let existingSha: string;
      try {
        existingSha = await getRef({
          repositoryFullName: request.repositoryFullName,
          ref: branch
        });
      } catch {
        // The re-read didn't explain the 422 either -- surface the original failure rather
        // than inventing one.
        throw error;
      }

      if (existingSha === request.sha) return;

      // Never force-update: rewriting the ref would replace a commit the approval never
      // covered. The caller decides what to do with a genuine conflict.
      throw new GitHubBranchConflictError(branch, request.sha, existingSha, { cause: error });
    }
  };

  const deleteBranch = async (request: DeleteBranchRequest): Promise<void> => {
    const branch = assertAutoStackBranch(request.ref);
    const repoPath = encodeRepositoryPath(request.repositoryFullName);

    try {
      await transport.request({
        method: "DELETE",
        path: `/repos/${repoPath}/git/refs/heads/${encodeRefPath(branch)}`,
        schema: z.void()
      });
    } catch (error) {
      // Cleanup must be idempotent: the live suite's `finally` block may run after a partial
      // failure that already deleted this ref, so a 404 here means "already deleted", not
      // "failed".
      if (error instanceof GitHubRequestError && error.status === 404) return;
      throw error;
    }
  };

  const putFileOnBranch = async (
    request: PutFileOnBranchRequest
  ): Promise<PutFileOnBranchResult> => {
    const branch = assertAutoStackBranch(request.branch);
    const contentsPath = encodeContentsPath(request.path);
    const repoPath = encodeRepositoryPath(request.repositoryFullName);
    const contentBase64 = Buffer.from(request.contentUtf8, "utf8").toString("base64");

    const result = await transport.request({
      method: "PUT",
      path: `/repos/${repoPath}/contents/${contentsPath}`,
      body: { message: request.message, content: contentBase64, branch },
      schema: putFileResponseSchema
    });

    return { contentSha: result.content.sha, commitSha: result.commit.sha };
  };

  return { getRef, createBranch, deleteBranch, putFileOnBranch };
};
