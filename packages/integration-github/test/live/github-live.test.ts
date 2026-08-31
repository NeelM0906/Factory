/**
 * Gated live validation against the real `NeelM0906/Factory` repository (S5 Task 10). This suite
 * is off by default and MUST stay off in CI -- see `live-config.ts` for the pure guards it relies
 * on, all of which are exercised unconditionally by `live-config.test.ts`.
 *
 * To run it locally (never in CI, never with a mock):
 *
 *   AUTOSTACK_LIVE_GITHUB=1 pnpm --filter @autostack/integration-github test -- live/github-live.test.ts
 *
 * Everything this suite creates lives under `autostack/e2e-*` and is removed again in the
 * `finally` block below, with every cleanup step individually try-wrapped and independently
 * re-verified via a fresh GET, so one cleanup failure can never strand the rest and can never be
 * mistaken for success. Only the PR number, branch names, and pass/fail are ever logged -- never
 * headers, tokens, or response bodies.
 */

import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { z } from "zod";

import { describe, expect, it } from "vitest";

import type { DraftPullRequestRequest, GitHubProgressCommentRequest } from "@autostack/contracts";
import { digestVersionedValue } from "@autostack/contracts";

import { createUserTokenAuth } from "../../src/auth/user-token.js";
import { encodeRepositoryPath } from "../../src/client/repository-path.js";
import { createGitHubTransport } from "../../src/client/transport.js";
import { GitHubRequestError } from "../../src/errors.js";
import { createGitHubIntegration } from "../../src/integration.js";
import { buildPublicationEvidenceFixture } from "../fixtures/publication-evidence.js";
import {
  LIVE_REPOSITORY_FULL_NAME,
  assertLiveRepository,
  assertPullRequestCiFilter,
  liveBranchName,
  readGhToken,
  type ExecFileLauncher
} from "./live-config.js";

const live = process.env.AUTOSTACK_LIVE_GITHUB === "1";

// One suite-wide timeout, generous enough for a full sequence of real, un-mocked GitHub REST
// calls (repository read, two branch creates, a file commit, a PR create + replay, a comment
// create + edit, a check-runs read, and the whole cleanup-and-verify chain in `finally`).
const LIVE_TEST_TIMEOUT_MS = 180_000;

const USER_AGENT = "autostack-live-suite/1.0";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../");

const REPOSITORY_PATH = encodeRepositoryPath(LIVE_REPOSITORY_FULL_NAME);

const realSleep = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason as unknown);
      },
      { once: true }
    );
  });

const repositoryInfoSchema = z.object({ default_branch: z.string() });
const gitRefSchema = z.object({ object: z.object({ sha: z.string() }) });
const pullRequestStateSchema = z.object({ number: z.number(), state: z.string() });
const pullRequestListSchema = z.array(z.object({ number: z.number() }));
const workflowRunsSchema = z.object({
  workflow_runs: z.array(z.object({ id: z.number(), status: z.string() }))
});

describe.skipIf(!live)("GitHub live validation", () => {
  it(
    "opens, verifies, and fully cleans up a draft PR against the live repository",
    async () => {
      // Step 0 (precondition): stop before opening anything if the worktree's CI workflow does
      // not exclude autostack/** pull requests -- see live-config.ts for why a substring check on
      // this file would not be trustworthy.
      const ciWorkflowYaml = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
      assertPullRequestCiFilter(ciWorkflowYaml);

      // Belt-and-suspenders, matching every branch-ref call site in this package: the repository
      // this suite is about to touch is asserted, not merely assumed, before any network call.
      assertLiveRepository(LIVE_REPOSITORY_FULL_NAME);

      const runId = randomUUID();
      const headBranchName = liveBranchName(`head-${runId}`);
      const baseBranchName = liveBranchName(`base-${runId}`);

      // Step 1: resolve the token from `gh auth token` via an injected launcher (executable+args,
      // never a shell string), and build the real integration against the real global fetch.
      const execFileAsync = promisify(execFileCallback);
      const ghExecFile: ExecFileLauncher = async (executable, args) => {
        const result = await execFileAsync(executable, [...args]);
        return { stdout: result.stdout, stderr: result.stderr };
      };
      const token = await readGhToken({ execFile: ghExecFile });
      const auth = createUserTokenAuth({ readToken: async () => token });

      const integration = createGitHubIntegration({
        auth,
        fetch: globalThis.fetch,
        now: () => Date.now(),
        userAgent: USER_AGENT,
        sleep: realSleep,
        random: Math.random
      });

      // A second transport instance for the handful of raw reads/writes this suite needs that
      // are deliberately NOT exposed on `GitHubIntegration` -- reading a non-`autostack/` default
      // branch, listing/cancelling workflow runs, and closing a pull request are all outside the
      // package's public surface by design (decision D2: this package does ref-level branch ops
      // and the delivery-integration port, nothing more).
      const transport = createGitHubTransport({
        fetch: globalThis.fetch,
        userAgent: USER_AGENT,
        authorization: () => auth.authorization(),
        now: () => Date.now(),
        sleep: realSleep,
        random: Math.random
      });

      let prNumber: number | undefined;
      let headCommitSha: string | undefined;
      let mainError: unknown;

      try {
        // Step 2: read the repository's default-branch head SHA.
        const repositoryInfo = await transport.request({
          method: "GET",
          path: `/repos/${REPOSITORY_PATH}`,
          schema: repositoryInfoSchema
        });
        const defaultBranchRef = await transport.request({
          method: "GET",
          path: `/repos/${REPOSITORY_PATH}/git/ref/heads/${encodeURIComponent(repositoryInfo.default_branch)}`,
          schema: gitRefSchema
        });
        const baseSha = defaultBranchRef.object.sha;

        // Step 3: create both e2e branches at that SHA. Both are under `autostack/`, so the PR
        // opened below is head -> base BETWEEN two e2e branches and never targets a product
        // branch.
        await integration.createBranch({
          repositoryFullName: LIVE_REPOSITORY_FULL_NAME,
          ref: baseBranchName,
          sha: baseSha
        });
        await integration.createBranch({
          repositoryFullName: LIVE_REPOSITORY_FULL_NAME,
          ref: headBranchName,
          sha: baseSha
        });

        // Step 4: give the head branch a real diff.
        const putFileResult = await integration.putFileOnBranch({
          repositoryFullName: LIVE_REPOSITORY_FULL_NAME,
          branch: headBranchName,
          path: `.autostack-e2e/${runId}.txt`,
          contentUtf8: `AutoStack S5 Task 10 live validation run ${runId}\n`,
          message: `AutoStack live validation run ${runId}`
        });
        headCommitSha = putFileResult.commitSha;

        // Step 5: a real PublicationEvidenceBundle for this head/base/diff, then open the draft
        // PR through the real client.
        const fixture = await buildPublicationEvidenceFixture({
          publishScope: {
            repositoryFullName: LIVE_REPOSITORY_FULL_NAME,
            base: baseBranchName,
            head: headBranchName
          }
        });

        const idempotencyKey = `live-e2e-pr-${runId}`;
        const prRequest: DraftPullRequestRequest = {
          schemaVersion: 1,
          idempotencyKey,
          repositoryFullName: LIVE_REPOSITORY_FULL_NAME,
          head: headBranchName,
          base: baseBranchName,
          title: `AutoStack live validation ${runId}`,
          body: `Automated live-validation draft PR for AutoStack S5 Task 10 (run ${runId}).`,
          draft: true,
          finalDiffDigest: fixture.publishScopeFields.finalDiffDigest,
          publicationEvidence: fixture.bundle
        };

        const created = await integration.createDraftPullRequest(prRequest);
        expect(created.draft).toBe(true);
        prNumber = created.number;
        // eslint-disable-next-line no-console -- deliberately the only progress log this suite emits.
        console.log(
          `live-github: opened draft PR #${created.number} (${headBranchName} -> ${baseBranchName})`
        );

        // Step 6: replay with the same idempotency key returns the same PR, without a second
        // side effect.
        const replayed = await integration.createDraftPullRequest(prRequest);
        expect(replayed.number).toBe(created.number);

        const owner = LIVE_REPOSITORY_FULL_NAME.split("/")[0];
        if (owner === undefined)
          throw new Error("Unreachable: LIVE_REPOSITORY_FULL_NAME has no owner segment.");
        const duplicateQuery = new URLSearchParams({
          head: `${owner}:${headBranchName}`,
          state: "all",
          base: baseBranchName
        });
        const duplicates = await transport.request({
          method: "GET",
          path: `/repos/${REPOSITORY_PATH}/pulls?${duplicateQuery.toString()}`,
          schema: pullRequestListSchema
        });
        expect(duplicates).toHaveLength(1);
        expect(duplicates[0]?.number).toBe(created.number);

        // Step 7: create a progress comment on the PR's issue (a PR's issue number IS its PR
        // number on GitHub), then edit it in place.
        const commentCreateRequest: GitHubProgressCommentRequest = {
          schemaVersion: 1,
          idempotencyKey: `live-e2e-comment-${runId}`,
          bindingRef: `live-e2e-${runId}`,
          repositoryFullName: LIVE_REPOSITORY_FULL_NAME,
          issueNumber: created.number,
          body: `AutoStack live validation: run ${runId} started.`,
          evidenceDigest: await digestVersionedValue("autostack.live-e2e.progress-comment", {
            runId,
            stage: "started"
          })
        };
        const commentCreated = await integration.upsertProgressComment(commentCreateRequest);
        expect(commentCreated.updated).toBe(false);

        const commentEditRequest: GitHubProgressCommentRequest = {
          schemaVersion: 1,
          idempotencyKey: `live-e2e-comment-edit-${runId}`,
          bindingRef: `live-e2e-${runId}`,
          repositoryFullName: LIVE_REPOSITORY_FULL_NAME,
          issueNumber: created.number,
          commentId: commentCreated.commentId,
          body: `AutoStack live validation: run ${runId} finished.`,
          evidenceDigest: await digestVersionedValue("autostack.live-e2e.progress-comment", {
            runId,
            stage: "finished"
          })
        };
        const commentEdited = await integration.upsertProgressComment(commentEditRequest);
        expect(commentEdited.updated).toBe(true);
        expect(commentEdited.commentId).toBe(commentCreated.commentId);

        const issueComments = await transport.request({
          method: "GET",
          path: `/repos/${REPOSITORY_PATH}/issues/${created.number}/comments`,
          schema: z.array(z.object({ id: z.number(), body: z.string() }))
        });
        expect(issueComments).toHaveLength(1);
        expect(issueComments[0]?.body).not.toBe(commentCreateRequest.body);

        // Step 8: read-only check-run listing for the head SHA. No action is taken on the result.
        const checkRuns = await integration.listCheckRuns({
          repositoryFullName: LIVE_REPOSITORY_FULL_NAME,
          ref: headCommitSha
        });
        expect(Array.isArray(checkRuns)).toBe(true);
      } catch (error) {
        mainError = error;
      } finally {
        // Step 9: cleanup. Every step below is individually try-wrapped so one failure cannot
        // strand the rest, and every removal is independently re-verified with a fresh GET.
        const cleanupErrors: unknown[] = [];

        if (headCommitSha !== undefined) {
          try {
            const runsForHead = await transport.request({
              method: "GET",
              path: `/repos/${REPOSITORY_PATH}/actions/runs?head_sha=${encodeURIComponent(headCommitSha)}`,
              schema: workflowRunsSchema
            });
            for (const run of runsForHead.workflow_runs) {
              if (run.status === "completed") continue;
              await transport.request({
                method: "POST",
                path: `/repos/${REPOSITORY_PATH}/actions/runs/${run.id}/cancel`,
                schema: z.unknown()
              });
            }
          } catch (error) {
            cleanupErrors.push(error);
          }
        }

        if (prNumber !== undefined) {
          try {
            await transport.request({
              method: "PATCH",
              path: `/repos/${REPOSITORY_PATH}/pulls/${prNumber}`,
              body: { state: "closed" },
              schema: pullRequestStateSchema
            });
          } catch (error) {
            cleanupErrors.push(error);
          }
        }

        try {
          await integration.deleteBranch({
            repositoryFullName: LIVE_REPOSITORY_FULL_NAME,
            ref: headBranchName
          });
        } catch (error) {
          cleanupErrors.push(error);
        }

        try {
          await integration.deleteBranch({
            repositoryFullName: LIVE_REPOSITORY_FULL_NAME,
            ref: baseBranchName
          });
        } catch (error) {
          cleanupErrors.push(error);
        }

        if (prNumber !== undefined) {
          try {
            const prState = await transport.request({
              method: "GET",
              path: `/repos/${REPOSITORY_PATH}/pulls/${prNumber}`,
              schema: pullRequestStateSchema
            });
            if (prState.state !== "closed") {
              throw new Error(
                `Live suite cleanup verification failed: PR #${prNumber} is not closed ` +
                  `(state="${prState.state}").`
              );
            }
          } catch (error) {
            cleanupErrors.push(error);
          }
        }

        const assertBranchDeleted = async (branch: string): Promise<void> => {
          try {
            await integration.getRef({
              repositoryFullName: LIVE_REPOSITORY_FULL_NAME,
              ref: branch
            });
          } catch (error) {
            if (error instanceof GitHubRequestError && error.status === 404) return;
            throw error;
          }
          throw new Error(
            `Live suite cleanup verification failed: branch "${branch}" still exists.`
          );
        };

        try {
          await assertBranchDeleted(headBranchName);
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await assertBranchDeleted(baseBranchName);
        } catch (error) {
          cleanupErrors.push(error);
        }

        const passed = mainError === undefined && cleanupErrors.length === 0;
        // eslint-disable-next-line no-console -- deliberately the only progress log this suite emits.
        console.log(
          `live-github: run ${runId}, PR #${String(prNumber)}, branches ${headBranchName} / ` +
            `${baseBranchName}: ${passed ? "PASS" : "FAIL"}`
        );

        if (mainError !== undefined) throw mainError;
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            cleanupErrors,
            `Live suite cleanup failed with ${cleanupErrors.length} error(s).`
          );
        }
      }
    },
    LIVE_TEST_TIMEOUT_MS
  );
});
