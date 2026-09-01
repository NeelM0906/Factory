import { z } from "zod";

import type { GitHubAuthStrategy } from "../auth/types.js";
import { GitHubRequestError, classifyGitHubFailure } from "../errors.js";
import { createGitHubTransport, readBoundedBody } from "./transport.js";

const DEFAULT_BASE_URL = "https://api.github.com";
// Bounds a runaway "next" link (or an implementation bug) to a fixed number of requests. At
// 100 repositories per page this covers 1000 accessible repositories -- far more than any
// Milestone A installation -- while guaranteeing this call always terminates.
const DEFAULT_MAXIMUM_PAGES = 10;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 1024 * 1024;

const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;

export interface GitHubUnsupportedAuthStrategyErrorOptions {
  readonly cause?: unknown;
}

/**
 * Thrown when `listInstallations`/`listAccessibleRepositories` is called with a `user_token`
 * auth strategy. A user token has no installations to enumerate (spec: "App-strategy only"),
 * so this is refused before any network I/O rather than issuing a request GitHub would reject
 * anyway.
 */
export class GitHubUnsupportedAuthStrategyError extends Error {
  readonly code = "unsupported_auth_strategy" as const;
  readonly retryable = false;

  constructor(operation: string, options: GitHubUnsupportedAuthStrategyErrorOptions = {}) {
    super(
      `GitHub installations operation "${operation}" requires an "app_installation" auth ` +
        "strategy; a user-token strategy has no installations to list."
    );
    this.name = "GitHubUnsupportedAuthStrategyError";
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        enumerable: false,
        writable: false,
        configurable: true
      });
    }
    Object.freeze(this);
  }
}

const assertAppInstallationStrategy = (auth: GitHubAuthStrategy, operation: string): void => {
  if (auth.kind !== "app_installation") {
    throw new GitHubUnsupportedAuthStrategyError(operation);
  }
};

// GitHub's installation object carries many more fields than this; only the ones the narrow
// result needs are modeled. Not `.strict()`, matching the rest of this package's convention of
// tolerating unmodeled provider fields.
const gitHubInstallationSchema = z.object({
  id: z.number().int(),
  account: z.object({ login: z.string().min(1) }),
  target_type: z.string().min(1)
});

const gitHubInstallationsResponseSchema = z.array(gitHubInstallationSchema);

const gitHubRepositoryPermissionsSchema = z.object({
  admin: z.boolean(),
  maintain: z.boolean(),
  push: z.boolean(),
  triage: z.boolean(),
  pull: z.boolean()
});

const gitHubAccessibleRepositorySchema = z.object({
  id: z.number().int(),
  full_name: z.string().min(1),
  default_branch: z.string().min(1),
  permissions: gitHubRepositoryPermissionsSchema
});

const gitHubAccessibleRepositoriesResponseSchema = z.object({
  total_count: z.number().int().nonnegative(),
  repositories: z.array(gitHubAccessibleRepositorySchema)
});

type GitHubAccessibleRepositoryRaw = z.infer<typeof gitHubAccessibleRepositorySchema>;

export interface GitHubInstallationSummary {
  readonly id: string;
  readonly accountLogin: string;
  readonly targetType: string;
}

export interface GitHubAccessibleRepositoryPermissions {
  readonly admin: boolean;
  readonly maintain: boolean;
  readonly push: boolean;
  readonly triage: boolean;
  readonly pull: boolean;
}

export interface GitHubAccessibleRepository {
  readonly id: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly permissions: GitHubAccessibleRepositoryPermissions;
}

export interface GitHubInstallationsClient {
  listInstallations(): Promise<readonly GitHubInstallationSummary[]>;
  listAccessibleRepositories(
    installationId: string
  ): Promise<readonly GitHubAccessibleRepository[]>;
}

export interface GitHubInstallationsClientDependencies {
  /**
   * Gates both operations (App-strategy only): a `user_token` strategy throws
   * {@link GitHubUnsupportedAuthStrategyError} before any fetch. For `listInstallations`, this
   * strategy's `authorization()` is also used directly as the App-level bearer for
   * `GET /app/installations` -- that endpoint authenticates the App itself, never an
   * installation, so the caller is expected to supply a strategy whose `authorization()`
   * mints the App's own JWT for this purpose (not an installation-scoped token).
   */
  readonly auth: GitHubAuthStrategy;
  /**
   * Mints a strategy scoped to an arbitrary installation, chosen at call time from
   * `listInstallations`'s result -- e.g. `(installationId) => createAppInstallationAuth({
   * appId, privateKeyPem, installationId, fetch, userAgent, now })` in the composition root.
   * `listAccessibleRepositories` never reuses `auth` itself for the request Authorization
   * header, since `auth` is not bound to any one installation.
   */
  readonly createInstallationAuth: (installationId: string) => GitHubAuthStrategy;
  readonly fetch: typeof globalThis.fetch;
  readonly userAgent: string;
  readonly now?: () => number;
  readonly baseUrl?: string;
  readonly maximumPages?: number;
  /** Per-page body ceiling for the paginated read, matching the transport's own default. */
  readonly maximumResponseBytes?: number;
}

const parseNextLinkUrl = (linkHeader: string | null): URL | undefined => {
  if (linkHeader === null) return undefined;
  // RFC 8288 Link header: comma-separated `<url>; rel="name"` entries.
  for (const entry of linkHeader.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(entry.trim());
    if (match?.[1] !== undefined) return new URL(match[1]);
  }
  return undefined;
};

interface FetchAllAccessibleRepositoryPagesOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly userAgent: string;
  readonly now: () => number;
  readonly authorization: () => Promise<string>;
  readonly initialUrl: URL;
  readonly maximumPages: number;
  readonly maximumResponseBytes: number;
}

/**
 * `GitHubTransport.request` deliberately returns only the schema-validated body, not response
 * headers, so it cannot expose the `Link` header pagination needs. Rather than widen that
 * shared, committed contract for one caller, this loop issues its own bounded, header-aware GET
 * requests, mirroring `transport.ts`'s security posture (`redirect: "manual"`, the same
 * required headers) exactly.
 */
const fetchAllAccessibleRepositoryPages = async (
  options: FetchAllAccessibleRepositoryPagesOptions
): Promise<readonly GitHubAccessibleRepositoryRaw[]> => {
  const allowedHost = options.initialUrl.host;
  const collected: GitHubAccessibleRepositoryRaw[] = [];
  let nextUrl: URL | undefined = options.initialUrl;
  let pagesFetched = 0;

  while (nextUrl !== undefined && pagesFetched < options.maximumPages) {
    const authorizationValue = await options.authorization();
    const headers = new Headers({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": options.userAgent,
      Authorization: authorizationValue
    });

    const response = await options.fetch(nextUrl, { method: "GET", headers, redirect: "manual" });
    pagesFetched += 1;

    if (response.status < 200 || response.status >= 300) {
      try {
        await response.body?.cancel();
      } catch {
        // The response is already terminal.
      }
      const classification = classifyGitHubFailure(response.status, response.headers, options.now);
      throw new GitHubRequestError(
        `GitHub request for installation repositories failed with status ${response.status}.`,
        response.status,
        classification.code,
        classification.retryable,
        { sensitiveValues: [authorizationValue] }
      );
    }

    // Bounded, not `response.json()`. This loop claims to mirror transport.ts's security posture,
    // and the byte bound is part of that posture: `response.json()` buffers whatever arrives, so
    // skipping it means trusting the provider to be well-behaved — the exact assumption the bound
    // exists to avoid. Shares the transport's own reader rather than duplicating it.
    const bodyText = await readBoundedBody(response, options.maximumResponseBytes, [
      authorizationValue
    ]);
    let rawBody: unknown;
    try {
      rawBody = bodyText === "" ? undefined : (JSON.parse(bodyText) as unknown);
    } catch (cause) {
      throw new GitHubRequestError(
        "GitHub installation-repositories response could not be parsed as JSON.",
        response.status,
        "invalid_response",
        false,
        { cause, sensitiveValues: [authorizationValue] }
      );
    }
    const parsed = gitHubAccessibleRepositoriesResponseSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new GitHubRequestError(
        "GitHub installation-repositories response did not match the expected schema.",
        response.status,
        "invalid_response",
        false,
        { cause: parsed.error, sensitiveValues: [authorizationValue] }
      );
    }
    collected.push(...parsed.data.repositories);

    const candidateNextUrl = parseNextLinkUrl(response.headers.get("link"));
    if (candidateNextUrl === undefined) {
      nextUrl = undefined;
    } else if (candidateNextUrl.host !== allowedHost) {
      // Security guard, not a nicety -- same reasoning as `transport.ts`'s `redirect: "manual"`:
      // following a foreign-host Link would replay this installation's Authorization header to
      // a host GitHub never intended it for. The wrong implementation follows any "next" URL
      // regardless of host; the accept-case test (a same-host "next" IS followed) is what
      // catches an implementation that instead refuses every "next" link unconditionally.
      throw new GitHubRequestError(
        "GitHub pagination Link header pointed at a foreign host, which is never followed.",
        response.status,
        "invalid_response",
        false,
        { sensitiveValues: [authorizationValue] }
      );
    } else {
      nextUrl = candidateNextUrl;
    }
  }

  return collected;
};

/**
 * Read-only installation and accessible-repository listing for the "connect a GitHub App
 * installation and select a repository" flow (acceptance criterion 2). Carries no policy
 * decision (§14.1) -- `permissions` is returned as data so a selection UI can show what the
 * installation may actually do; nothing here acts on it.
 */
export const createInstallationsClient = (
  deps: GitHubInstallationsClientDependencies
): GitHubInstallationsClient => {
  const baseUrl = normalizeBaseUrl(deps.baseUrl ?? DEFAULT_BASE_URL);
  const maximumPages = deps.maximumPages ?? DEFAULT_MAXIMUM_PAGES;
  const now = deps.now ?? ((): number => 0);

  const listInstallations = async (): Promise<readonly GitHubInstallationSummary[]> => {
    assertAppInstallationStrategy(deps.auth, "listInstallations");

    const transport = createGitHubTransport({
      fetch: deps.fetch,
      userAgent: deps.userAgent,
      authorization: () => deps.auth.authorization(),
      baseUrl,
      ...(deps.now !== undefined ? { now: deps.now } : {})
    });

    const installations = await transport.request({
      method: "GET",
      path: "/app/installations",
      schema: gitHubInstallationsResponseSchema
    });

    return installations.map((installation) => ({
      id: String(installation.id),
      accountLogin: installation.account.login,
      targetType: installation.target_type
    }));
  };

  const listAccessibleRepositories = async (
    installationId: string
  ): Promise<readonly GitHubAccessibleRepository[]> => {
    assertAppInstallationStrategy(deps.auth, "listAccessibleRepositories");

    const installationAuth = deps.createInstallationAuth(installationId);
    const repositories = await fetchAllAccessibleRepositoryPages({
      fetch: deps.fetch,
      userAgent: deps.userAgent,
      now,
      authorization: () => installationAuth.authorization(),
      initialUrl: new URL(`${baseUrl}/installation/repositories`),
      maximumPages,
      maximumResponseBytes: deps.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES
    });

    return repositories.map((repository) => ({
      id: String(repository.id),
      fullName: repository.full_name,
      defaultBranch: repository.default_branch,
      permissions: {
        admin: repository.permissions.admin,
        maintain: repository.permissions.maintain,
        push: repository.permissions.push,
        triage: repository.permissions.triage,
        pull: repository.permissions.pull
      }
    }));
  };

  return { listInstallations, listAccessibleRepositories };
};
