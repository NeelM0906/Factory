/**
 * The declared read scope of a role's context assembly: the set of workspace prefixes the
 * assembler may read without asking. Everything outside it goes through the permission gate.
 */
export interface ContextScope {
  /** Relative workspace prefixes (a directory, or an exact file path) that are in scope. */
  readonly includePrefixes: readonly string[];
}

/**
 * A path is in scope when it equals an include prefix or sits under it across a `/` segment
 * boundary — `docs2/notes.md` is NOT inside the prefix `docs`, so a raw `startsWith` is wrong.
 */
export const isPathInScope = (scope: ContextScope, path: string): boolean =>
  scope.includePrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
