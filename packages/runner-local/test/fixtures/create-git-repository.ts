import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const FIXTURE_ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0"
});

export interface GitRepositoryFixture {
  readonly root: string;
  readonly sourcePath: string;
  readonly managedWorktreeRoot: string;
  readonly privateConfigRoot: string;
  readonly baseBranch: string;
  readonly firstCommit: string;
  readonly secondCommit: string;
}

export interface SourceCheckoutInvariant {
  readonly head: string;
  readonly branch: string;
  readonly indexDigest: string;
  readonly configDigest: string;
  readonly files: readonly {
    readonly name: string;
    readonly digest: string;
    readonly byteSize: number;
  }[];
}

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const result = await execFileAsync("/usr/bin/git", args, {
    cwd,
    env: FIXTURE_ENVIRONMENT,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000
  });
  return result.stdout.trim();
};

export const createGitRepository = async (): Promise<GitRepositoryFixture> => {
  const root = await mkdtemp(join(tmpdir(), "autostack-git-client-"));
  const sourcePath = join(root, "source");
  const managedWorktreeRoot = join(root, "managed", "worktrees");
  const privateConfigRoot = join(root, "private-git-config");
  await mkdir(sourcePath, { mode: 0o700 });
  await mkdir(managedWorktreeRoot, { recursive: true, mode: 0o700 });
  await mkdir(privateConfigRoot, { mode: 0o700 });
  await mkdir(join(privateConfigRoot, "home"), { mode: 0o700 });
  await mkdir(join(privateConfigRoot, "xdg"), { mode: 0o700 });
  await git(sourcePath, ["init", "--initial-branch=main"]);
  await git(sourcePath, ["config", "user.name", "AutoStack Test"]);
  await git(sourcePath, ["config", "user.email", "autostack@example.test"]);
  await writeFile(join(sourcePath, "tracked.txt"), "first\n", { mode: 0o600 });
  await git(sourcePath, ["add", "--", "tracked.txt"]);
  await git(sourcePath, ["commit", "-m", "first"]);
  const firstCommit = await git(sourcePath, ["rev-parse", "HEAD"]);
  await writeFile(join(sourcePath, "tracked.txt"), "second\n", { mode: 0o600 });
  await git(sourcePath, ["commit", "-am", "second"]);
  const secondCommit = await git(sourcePath, ["rev-parse", "HEAD"]);
  return {
    root: await realpath(root),
    sourcePath: await realpath(sourcePath),
    managedWorktreeRoot: await realpath(managedWorktreeRoot),
    privateConfigRoot: await realpath(privateConfigRoot),
    baseBranch: "main",
    firstCommit,
    secondCommit
  };
};

export const captureSourceCheckoutInvariant = async (
  fixture: GitRepositoryFixture
): Promise<SourceCheckoutInvariant> => {
  const head = await git(fixture.sourcePath, ["rev-parse", "HEAD"]);
  const branch = await git(fixture.sourcePath, ["symbolic-ref", "--short", "HEAD"]);
  const indexPath = await git(fixture.sourcePath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index"
  ]);
  const configPath = await git(fixture.sourcePath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "config"
  ]);
  const namesOutput = await execFileAsync(
    "/usr/bin/git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: fixture.sourcePath,
      env: FIXTURE_ENVIRONMENT,
      encoding: "buffer",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000
    }
  );
  const names = namesOutput.stdout
    .toString("utf8")
    .split("\0")
    .filter((name) => name.length > 0)
    .sort();
  const files = await Promise.all(
    names.map(async (name) => {
      const bytes = await readFile(join(fixture.sourcePath, name));
      return {
        name,
        digest: createHash("sha256").update(bytes).digest("hex"),
        byteSize: bytes.byteLength
      };
    })
  );
  const indexBytes = await readFile(indexPath);
  const configBytes = await readFile(configPath);
  return {
    head,
    branch,
    indexDigest: createHash("sha256").update(indexBytes).digest("hex"),
    configDigest: createHash("sha256").update(configBytes).digest("hex"),
    files
  };
};

export const configureRepository = async (
  fixture: GitRepositoryFixture,
  key: string,
  value: string
): Promise<void> => {
  await git(fixture.sourcePath, ["config", "--local", key, value]);
};

export const createSentinelExecutable = async (
  fixture: GitRepositoryFixture,
  name: string
): Promise<{ readonly executablePath: string; readonly sentinelPath: string }> => {
  const directory = join(fixture.root, "sentinels");
  await mkdir(directory, { mode: 0o700 });
  const executablePath = join(directory, name);
  const sentinelPath = join(directory, `${basename(name)}.invoked`);
  await writeFile(
    executablePath,
    `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(sentinelPath)}\n/bin/cat\n`,
    { mode: 0o700 }
  );
  await chmod(executablePath, 0o700);
  return { executablePath, sentinelPath };
};

export const gitFixtureCommand = git;

export const fixtureGitDirectory = async (fixture: GitRepositoryFixture): Promise<string> =>
  realpath(join(fixture.sourcePath, ".git"));

export const fixtureRootFor = (path: string): string => dirname(path);
