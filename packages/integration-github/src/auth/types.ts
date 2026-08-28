export type GitHubAuthKind = "user_token" | "app_installation";

export interface GitHubAuthorizationOptions {
  readonly signal?: AbortSignal;
}

export interface GitHubAuthDescription {
  readonly kind: GitHubAuthKind;
  readonly subject: string;
}

/**
 * A GitHub authentication strategy. `authorization()` returns a complete `Authorization`
 * header value; callers never cache it themselves, since the `app_installation` strategy
 * refreshes on its own schedule. `describe()` is safe to log -- it carries no secret material.
 */
export interface GitHubAuthStrategy {
  readonly kind: GitHubAuthKind;
  authorization(options?: GitHubAuthorizationOptions): Promise<string>;
  describe(): GitHubAuthDescription;
}
