import { describe, expect, it, vi } from "vitest";

import type { GitHubAuthKind, GitHubAuthStrategy } from "../../src/auth/types.js";
import {
  GitHubUnsupportedAuthStrategyError,
  createInstallationsClient,
  type GitHubInstallationsClientDependencies
} from "../../src/client/installations.js";

const USER_AGENT = "autostack-test/1.0";
const APP_JWT_AUTHORIZATION = "Bearer app-jwt-fixture-value";

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

type FetchHandler = (call: RecordedCall, callIndex: number) => Response | Promise<Response>;

const createRecordingFetch = (): {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: RecordedCall[];
  setHandler(handler: FetchHandler): void;
} => {
  const calls: RecordedCall[] = [];
  let handler: FetchHandler = () => {
    throw new Error("no fetch handler configured for this test");
  };
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    calls,
    setHandler: (nextHandler) => {
      handler = nextHandler;
    }
  };
};

const jsonResponse = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });

const createStubAuth = (kind: GitHubAuthKind, authorizationValue: string): GitHubAuthStrategy => ({
  kind,
  authorization: async () => authorizationValue,
  describe: () => ({ kind, subject: "stub-subject" })
});

const installationAuthorizationFor = (installationId: string): string =>
  `Bearer installation-token-for-${installationId}`;

const createInstallationAuthFactory =
  (): ((installationId: string) => GitHubAuthStrategy) => (installationId: string) =>
    createStubAuth("app_installation", installationAuthorizationFor(installationId));

const buildDeps = (
  fetch: typeof globalThis.fetch,
  overrides: Partial<GitHubInstallationsClientDependencies> = {}
): GitHubInstallationsClientDependencies => ({
  auth: createStubAuth("app_installation", APP_JWT_AUTHORIZATION),
  createInstallationAuth: createInstallationAuthFactory(),
  fetch,
  userAgent: USER_AGENT,
  ...overrides
});

const installationPayload = (id: number, login: string, targetType: string): unknown => ({
  id,
  account: { login, id: id * 10 },
  target_type: targetType,
  app_id: 999,
  html_url: `https://github.com/settings/installations/${id}`
});

const repositoryPayload = (
  id: number,
  fullName: string,
  defaultBranch: string,
  permissions: Record<string, boolean>
): unknown => ({
  id,
  full_name: fullName,
  default_branch: defaultBranch,
  permissions,
  // Raw-provider-only fields that must never leak into the narrow result shape.
  clone_url: `https://github.com/${fullName}.git`,
  ssh_url: `git@github.com:${fullName}.git`
});

const FULL_PERMISSIONS = { admin: false, maintain: false, push: true, triage: false, pull: true };

describe("createInstallationsClient", () => {
  describe("listInstallations", () => {
    it("lists installations via GET /app/installations using the app JWT, mapped to the narrow shape", async () => {
      const recording = createRecordingFetch();
      recording.setHandler(() =>
        jsonResponse([
          installationPayload(1, "acme-corp", "Organization"),
          installationPayload(2, "octocat", "User")
        ])
      );
      const client = createInstallationsClient(buildDeps(recording.fetch));

      const result = await client.listInstallations();

      expect(recording.calls).toHaveLength(1);
      const call = recording.calls[0];
      if (call === undefined) throw new Error("expected a recorded fetch call");
      expect(call.url).toBe("https://api.github.com/app/installations");
      expect(call.init.method).toBe("GET");
      // Proves the APP-level authorization was used, not some other value -- a stub that
      // ignored which strategy was configured could still pass a test that only checked
      // "some Authorization header was sent".
      expect(new Headers(call.init.headers).get("authorization")).toBe(APP_JWT_AUTHORIZATION);

      expect(result).toEqual([
        { id: "1", accountLogin: "acme-corp", targetType: "Organization" },
        { id: "2", accountLogin: "octocat", targetType: "User" }
      ]);
    });

    it("throws GitHubUnsupportedAuthStrategyError for a user-token strategy without ever calling fetch", async () => {
      const recording = createRecordingFetch();
      const client = createInstallationsClient(
        buildDeps(recording.fetch, { auth: createStubAuth("user_token", "token some-value") })
      );

      await expect(client.listInstallations()).rejects.toThrow(GitHubUnsupportedAuthStrategyError);
      await expect(client.listInstallations()).rejects.toMatchObject({
        code: "unsupported_auth_strategy"
      });
      // Guard-test doctrine: assert the fetch stub was never invoked, not merely that the call
      // rejected -- a wrong implementation could throw AFTER issuing a doomed request, which
      // "it threw" alone would not catch.
      expect(recording.fetch).not.toHaveBeenCalled();
      expect(recording.calls).toHaveLength(0);
    });
  });

  describe("listAccessibleRepositories", () => {
    it("lists accessible repositories via GET /installation/repositories using the token for THAT installation", async () => {
      const recording = createRecordingFetch();
      recording.setHandler(() =>
        jsonResponse({
          total_count: 1,
          repositories: [repositoryPayload(11, "acme-corp/widgets", "main", FULL_PERMISSIONS)]
        })
      );
      const client = createInstallationsClient(buildDeps(recording.fetch));

      const result = await client.listAccessibleRepositories("42");

      expect(recording.calls).toHaveLength(1);
      const call = recording.calls[0];
      if (call === undefined) throw new Error("expected a recorded fetch call");
      expect(call.url).toBe("https://api.github.com/installation/repositories");
      // Proves installationId actually selects which token is used -- a wrong implementation
      // that ignored the parameter and reused the app-level auth would still "work" on a
      // single-installation fixture but send the wrong token here.
      expect(new Headers(call.init.headers).get("authorization")).toBe(
        installationAuthorizationFor("42")
      );

      expect(result).toEqual([
        {
          id: "11",
          fullName: "acme-corp/widgets",
          defaultBranch: "main",
          permissions: FULL_PERMISSIONS
        }
      ]);
    });

    it("throws GitHubUnsupportedAuthStrategyError for a user-token strategy without ever calling fetch", async () => {
      const recording = createRecordingFetch();
      const client = createInstallationsClient(
        buildDeps(recording.fetch, { auth: createStubAuth("user_token", "token some-value") })
      );

      await expect(client.listAccessibleRepositories("42")).rejects.toThrow(
        GitHubUnsupportedAuthStrategyError
      );
      expect(recording.fetch).not.toHaveBeenCalled();
      expect(recording.calls).toHaveLength(0);
    });

    it("follows a same-host Link 'next' page and aggregates results across pages (accept-case)", async () => {
      const recording = createRecordingFetch();
      recording.setHandler((call, index) => {
        if (index === 0) {
          expect(call.url).toBe("https://api.github.com/installation/repositories");
          return jsonResponse(
            {
              total_count: 2,
              repositories: [repositoryPayload(1, "acme/a", "main", FULL_PERMISSIONS)]
            },
            200,
            { link: '<https://api.github.com/installation/repositories?page=2>; rel="next"' }
          );
        }
        expect(call.url).toBe("https://api.github.com/installation/repositories?page=2");
        return jsonResponse({
          total_count: 2,
          repositories: [repositoryPayload(2, "acme/b", "main", FULL_PERMISSIONS)]
        });
      });
      const client = createInstallationsClient(buildDeps(recording.fetch));

      const result = await client.listAccessibleRepositories("42");

      expect(recording.calls).toHaveLength(2);
      expect(result.map((repository) => repository.fullName)).toEqual(["acme/a", "acme/b"]);
    });

    it("refuses a Link 'next' page pointing at a foreign host and issues no further fetch to it (reject-case)", async () => {
      const recording = createRecordingFetch();
      recording.setHandler(() =>
        jsonResponse(
          {
            total_count: 2,
            repositories: [repositoryPayload(1, "acme/a", "main", FULL_PERMISSIONS)]
          },
          200,
          { link: '<https://evil.example/installation/repositories?page=2>; rel="next"' }
        )
      );
      const client = createInstallationsClient(buildDeps(recording.fetch));

      await expect(client.listAccessibleRepositories("42")).rejects.toThrow(/foreign host|host/i);
      // Without this, "refuse every next link" would pass the same way "follow every next
      // link" fails the accept-case above -- only asserting zero calls to the foreign host
      // (here: no second fetch call at all) distinguishes a real host check from one that
      // rejects unconditionally.
      expect(recording.calls).toHaveLength(1);
      expect(recording.calls.every((call) => !call.url.includes("evil.example"))).toBe(true);
    });

    it("stops following pagination at the configured page bound even when the server always returns a 'next' link", async () => {
      const recording = createRecordingFetch();
      recording.setHandler((call, index) =>
        jsonResponse(
          {
            total_count: 999,
            repositories: [repositoryPayload(index + 1, `acme/r${index}`, "main", FULL_PERMISSIONS)]
          },
          200,
          {
            link: `<https://api.github.com/installation/repositories?page=${index + 2}>; rel="next"`
          }
        )
      );
      const client = createInstallationsClient(buildDeps(recording.fetch, { maximumPages: 3 }));

      const result = await client.listAccessibleRepositories("42");

      // An unbounded implementation would loop forever (or until the fake handler ran out of
      // logic) on a server that always supplies a "next" link; only a call-count assertion
      // proves the bound actually stopped the loop -- "we got all the pages we asked for"
      // passes for an unbounded implementation too.
      expect(recording.calls).toHaveLength(3);
      expect(result).toHaveLength(3);
    });

    it("stops pagination when a page carries no Link 'next' header", async () => {
      const recording = createRecordingFetch();
      recording.setHandler(() =>
        jsonResponse({
          total_count: 1,
          repositories: [repositoryPayload(1, "acme/a", "main", FULL_PERMISSIONS)]
        })
      );
      const client = createInstallationsClient(buildDeps(recording.fetch));

      const result = await client.listAccessibleRepositories("42");

      expect(recording.calls).toHaveLength(1);
      expect(result).toHaveLength(1);
    });
  });

  describe("credential and payload hygiene", () => {
    it("never exposes the app JWT, installation token, or raw provider payload in a schema-failure error", async () => {
      const recording = createRecordingFetch();
      recording.setHandler(() => jsonResponse({ not: "the expected shape" }));
      const client = createInstallationsClient(buildDeps(recording.fetch));

      await expect(client.listInstallations()).rejects.toSatisfy((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const serialized = JSON.stringify(error);
        return (
          !message.includes(APP_JWT_AUTHORIZATION) &&
          !message.includes("Bearer") &&
          serialized !== undefined &&
          !serialized.includes(APP_JWT_AUTHORIZATION)
        );
      });
    });

    it("never exposes the installation token in a foreign-host pagination refusal error", async () => {
      const recording = createRecordingFetch();
      recording.setHandler(() =>
        jsonResponse(
          {
            total_count: 2,
            repositories: [repositoryPayload(1, "acme/a", "main", FULL_PERMISSIONS)]
          },
          200,
          { link: '<https://evil.example/installation/repositories?page=2>; rel="next"' }
        )
      );
      const client = createInstallationsClient(buildDeps(recording.fetch));

      const installationToken = installationAuthorizationFor("42");
      await expect(client.listAccessibleRepositories("42")).rejects.toSatisfy((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return !message.includes(installationToken) && !message.includes("Bearer");
      });
    });

    it("does not expose raw provider-only fields (e.g. clone_url) on the mapped repository result", async () => {
      const recording = createRecordingFetch();
      recording.setHandler(() =>
        jsonResponse({
          total_count: 1,
          repositories: [repositoryPayload(1, "acme/a", "main", FULL_PERMISSIONS)]
        })
      );
      const client = createInstallationsClient(buildDeps(recording.fetch));

      const [repository] = await client.listAccessibleRepositories("42");
      if (repository === undefined) throw new Error("expected one repository");

      expect(Object.keys(repository).sort()).toEqual(
        ["defaultBranch", "fullName", "id", "permissions"].sort()
      );
    });
  });
});
