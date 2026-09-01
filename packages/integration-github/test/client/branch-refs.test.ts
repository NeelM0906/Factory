import { describe, expect, it, vi } from "vitest";

import {
  GitHubBranchConflictError,
  GitHubBranchPolicyError,
  GitHubRequestError
} from "../../src/errors.js";
import { createBranchRefsClient } from "../../src/client/branch-refs.js";
import type { GitHubTransport } from "../../src/client/transport.js";

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

const createStubTransport = (
  handler: (call: RecordedRequest, index: number) => unknown
): { readonly transport: GitHubTransport; readonly calls: RecordedRequest[] } => {
  const calls: RecordedRequest[] = [];
  const request = vi.fn(async (spec: { method: string; path: string; body?: unknown }) => {
    const call: RecordedRequest = { method: spec.method, path: spec.path, body: spec.body };
    calls.push(call);
    return handler(call, calls.length - 1);
  });
  return { transport: { request } as unknown as GitHubTransport, calls };
};

const notFound = new GitHubRequestError("not found", 404, "not_found", false);
const referenceExists = new GitHubRequestError(
  "reference already exists",
  422,
  "invalid_request",
  false
);
const serverError = new GitHubRequestError("server error", 500, "provider_unavailable", true);

describe("branch-refs client", () => {
  describe("getRef", () => {
    it("returns the resolved commit sha", async () => {
      const { transport, calls } = createStubTransport(() => ({
        ref: "refs/heads/autostack/x",
        object: { sha: "abc123", type: "commit" }
      }));
      const client = createBranchRefsClient(transport);

      const sha = await client.getRef({ repositoryFullName: "owner/repo", ref: "autostack/x" });

      expect(sha).toBe("abc123");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        method: "GET",
        path: "/repos/owner/repo/git/ref/heads/autostack/x"
      });
    });

    it("rejects a non-autostack ref before any network call", async () => {
      const { transport, calls } = createStubTransport(() => {
        throw new Error("must not be reached");
      });
      const client = createBranchRefsClient(transport);

      await expect(
        client.getRef({ repositoryFullName: "owner/repo", ref: "main" })
      ).rejects.toThrow(GitHubBranchPolicyError);
      expect(calls).toHaveLength(0);
    });
  });

  describe("createBranch", () => {
    it("creates a branch at the given sha on a fresh create", async () => {
      const { transport, calls } = createStubTransport(() => ({
        ref: "refs/heads/autostack/x",
        object: { sha: "sha-1", type: "commit" }
      }));
      const client = createBranchRefsClient(transport);

      await client.createBranch({
        repositoryFullName: "owner/repo",
        ref: "autostack/x",
        sha: "sha-1"
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        method: "POST",
        path: "/repos/owner/repo/git/refs",
        body: { ref: "refs/heads/autostack/x", sha: "sha-1" }
      });
    });

    it("resolves as already-created when a 422 re-read finds the same sha", async () => {
      const { transport, calls } = createStubTransport((_call, index) => {
        if (index === 0) throw referenceExists;
        return { ref: "refs/heads/autostack/x", object: { sha: "sha-1", type: "commit" } };
      });
      const client = createBranchRefsClient(transport);

      await expect(
        client.createBranch({ repositoryFullName: "owner/repo", ref: "autostack/x", sha: "sha-1" })
      ).resolves.toBeUndefined();

      expect(calls).toHaveLength(2);
      expect(calls[0]?.method).toBe("POST");
      expect(calls[1]).toMatchObject({
        method: "GET",
        path: "/repos/owner/repo/git/ref/heads/autostack/x"
      });
    });

    it("throws GitHubBranchConflictError when a 422 re-read finds a different sha, issuing no update call", async () => {
      const { transport, calls } = createStubTransport((_call, index) => {
        if (index === 0) throw referenceExists;
        return { ref: "refs/heads/autostack/x", object: { sha: "sha-existing", type: "commit" } };
      });
      const client = createBranchRefsClient(transport);

      const failure = await client
        .createBranch({
          repositoryFullName: "owner/repo",
          ref: "autostack/x",
          sha: "sha-requested"
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(GitHubBranchConflictError);
      expect((failure as GitHubBranchConflictError).requestedSha).toBe("sha-requested");
      expect((failure as GitHubBranchConflictError).existingSha).toBe("sha-existing");
      // Exactly the POST and the re-read GET -- never a force-update call.
      expect(calls).toHaveLength(2);
      expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
    });

    it("rethrows the original 422 when the re-read itself fails", async () => {
      const { transport, calls } = createStubTransport((_call, index) => {
        if (index === 0) throw referenceExists;
        throw notFound;
      });
      const client = createBranchRefsClient(transport);

      const failure = await client
        .createBranch({ repositoryFullName: "owner/repo", ref: "autostack/x", sha: "sha-1" })
        .catch((error: unknown) => error);

      expect(failure).toBe(referenceExists);
      expect(calls).toHaveLength(2);
    });

    it("does not retry a non-422 failure via the re-read path", async () => {
      const { transport, calls } = createStubTransport(() => {
        throw serverError;
      });
      const client = createBranchRefsClient(transport);

      const failure = await client
        .createBranch({ repositoryFullName: "owner/repo", ref: "autostack/x", sha: "sha-1" })
        .catch((error: unknown) => error);

      expect(failure).toBe(serverError);
      expect(calls).toHaveLength(1);
    });

    it("rejects a non-autostack ref before any network call", async () => {
      const { transport, calls } = createStubTransport(() => {
        throw new Error("must not be reached");
      });
      const client = createBranchRefsClient(transport);

      await expect(
        client.createBranch({ repositoryFullName: "owner/repo", ref: "main", sha: "sha-1" })
      ).rejects.toThrow(GitHubBranchPolicyError);
      expect(calls).toHaveLength(0);
    });
  });

  describe("deleteBranch", () => {
    it("deletes the branch", async () => {
      const { transport, calls } = createStubTransport(() => undefined);
      const client = createBranchRefsClient(transport);

      await client.deleteBranch({ repositoryFullName: "owner/repo", ref: "autostack/x" });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        method: "DELETE",
        path: "/repos/owner/repo/git/refs/heads/autostack/x"
      });
    });

    it("treats a 404 as already-deleted", async () => {
      const { transport, calls } = createStubTransport(() => {
        throw notFound;
      });
      const client = createBranchRefsClient(transport);

      await expect(
        client.deleteBranch({ repositoryFullName: "owner/repo", ref: "autostack/x" })
      ).resolves.toBeUndefined();
      expect(calls).toHaveLength(1);
    });

    it("rethrows a non-404 failure", async () => {
      const { transport } = createStubTransport(() => {
        throw serverError;
      });
      const client = createBranchRefsClient(transport);

      const failure = await client
        .deleteBranch({ repositoryFullName: "owner/repo", ref: "autostack/x" })
        .catch((error: unknown) => error);
      expect(failure).toBe(serverError);
    });

    it("rejects a non-autostack ref before any network call", async () => {
      const { transport, calls } = createStubTransport(() => {
        throw new Error("must not be reached");
      });
      const client = createBranchRefsClient(transport);

      await expect(
        client.deleteBranch({ repositoryFullName: "owner/repo", ref: "codex/foo" })
      ).rejects.toThrow(GitHubBranchPolicyError);
      expect(calls).toHaveLength(0);
    });
  });

  describe("putFileOnBranch", () => {
    it("puts base64-encoded content on the branch", async () => {
      const { transport, calls } = createStubTransport(() => ({
        content: { sha: "content-sha" },
        commit: { sha: "commit-sha" }
      }));
      const client = createBranchRefsClient(transport);

      const result = await client.putFileOnBranch({
        repositoryFullName: "owner/repo",
        branch: "autostack/x",
        path: "docs/notes.txt",
        contentUtf8: "hello world",
        message: "add notes"
      });

      expect(result).toEqual({ contentSha: "content-sha", commitSha: "commit-sha" });
      expect(calls).toHaveLength(1);
      const call = calls[0];
      expect(call).toMatchObject({
        method: "PUT",
        path: "/repos/owner/repo/contents/docs/notes.txt"
      });
      expect(call?.body).toMatchObject({
        message: "add notes",
        branch: "autostack/x",
        content: Buffer.from("hello world", "utf8").toString("base64")
      });
    });

    it("rejects an absolute path before any network call", async () => {
      const { transport, calls } = createStubTransport(() => {
        throw new Error("must not be reached");
      });
      const client = createBranchRefsClient(transport);

      await expect(
        client.putFileOnBranch({
          repositoryFullName: "owner/repo",
          branch: "autostack/x",
          path: "/etc/passwd",
          contentUtf8: "x",
          message: "m"
        })
      ).rejects.toThrow(GitHubRequestError);
      expect(calls).toHaveLength(0);
    });

    it("rejects a path containing .. before any network call", async () => {
      const { transport, calls } = createStubTransport(() => {
        throw new Error("must not be reached");
      });
      const client = createBranchRefsClient(transport);

      await expect(
        client.putFileOnBranch({
          repositoryFullName: "owner/repo",
          branch: "autostack/x",
          path: "a/../../etc/passwd",
          contentUtf8: "x",
          message: "m"
        })
      ).rejects.toThrow(GitHubRequestError);
      expect(calls).toHaveLength(0);
    });

    it("rejects a path containing a NUL byte before any network call", async () => {
      const { transport, calls } = createStubTransport(() => {
        throw new Error("must not be reached");
      });
      const client = createBranchRefsClient(transport);

      await expect(
        client.putFileOnBranch({
          repositoryFullName: "owner/repo",
          branch: "autostack/x",
          path: "a/b\0c",
          contentUtf8: "x",
          message: "m"
        })
      ).rejects.toThrow(GitHubRequestError);
      expect(calls).toHaveLength(0);
    });

    it("rejects a non-autostack branch before any network call", async () => {
      const { transport, calls } = createStubTransport(() => {
        throw new Error("must not be reached");
      });
      const client = createBranchRefsClient(transport);

      await expect(
        client.putFileOnBranch({
          repositoryFullName: "owner/repo",
          branch: "main",
          path: "docs/notes.txt",
          contentUtf8: "x",
          message: "m"
        })
      ).rejects.toThrow(GitHubBranchPolicyError);
      expect(calls).toHaveLength(0);
    });
  });

  describe("repositoryFullName", () => {
    it("rejects a malformed repository full name before any network call", async () => {
      const { transport, calls } = createStubTransport(() => {
        throw new Error("must not be reached");
      });
      const client = createBranchRefsClient(transport);

      await expect(
        client.getRef({ repositoryFullName: "not-a-valid-name", ref: "autostack/x" })
      ).rejects.toThrow(GitHubRequestError);
      expect(calls).toHaveLength(0);
    });

    it("URL-encodes owner and repo per segment, never encodeURI on the joined string", async () => {
      const { transport, calls } = createStubTransport(() => ({
        ref: "refs/heads/autostack/x",
        object: { sha: "abc123", type: "commit" }
      }));
      const client = createBranchRefsClient(transport);

      await client.getRef({ repositoryFullName: "acme@corp/repo+plus", ref: "autostack/x" });

      expect(calls[0]?.path).toBe("/repos/acme%40corp/repo%2Bplus/git/ref/heads/autostack/x");
    });
  });
});
