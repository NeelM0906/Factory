import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InspectRepositoryRequest } from "@autostack/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  BoundedProcessRunner,
  ProcessRunError,
  type ProcessRunRequest,
  type ProcessRunner
} from "../src/process-runner.js";
import {
  GitClient,
  GitClientError,
  parseWorktreePorcelainZ,
  type GitProcessRunner
} from "../src/git-client.js";
import { PathPolicyError } from "../src/path-policy.js";
import {
  captureSourceCheckoutInvariant,
  configureRepository,
  createGitRepository,
  createSentinelExecutable,
  fixtureGitDirectory,
  gitFixtureCommand,
  type GitRepositoryFixture
} from "./fixtures/create-git-repository.js";

const cleanupRoots: string[] = [];

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForProcessExit = async (pid: number, timeoutMs = 2_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return !processIsAlive(pid);
};

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const fixtureRequest = (fixture: GitRepositoryFixture): InspectRepositoryRequest => ({
  sourcePath: fixture.sourcePath,
  baseRef: fixture.baseBranch
});

const createClient = async (
  fixture: GitRepositoryFixture,
  processRunner?: GitProcessRunner
): Promise<GitClient> =>
  GitClient.create({
    managedWorktreeRoot: fixture.managedWorktreeRoot,
    privateConfigRoot: fixture.privateConfigRoot,
    trustedGitExecutable: "/usr/bin/git",
    ...(processRunner === undefined ? {} : { processRunner })
  });

describe("BoundedProcessRunner", () => {
  test("passes executable arguments without shell interpretation and starts from the supplied environment", async () => {
    const runner = new BoundedProcessRunner({ timeoutMs: 5_000, maximumOutputBytes: 64 * 1024 });
    const previous = process.env.AUTOSTACK_PARENT_SENTINEL;
    process.env.AUTOSTACK_PARENT_SENTINEL = "must-not-inherit";
    let result;
    try {
      result = await runner.run({
        executable: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({args:process.argv.slice(1), inherited:process.env.AUTOSTACK_PARENT_SENTINEL ?? null, exact:process.env.EXACT}))",
          "$(touch should-not-exist)",
          "; exit 91"
        ],
        cwd: tmpdir(),
        environment: [{ name: "EXACT", value: "present" }]
      });
    } finally {
      if (previous === undefined) delete process.env.AUTOSTACK_PARENT_SENTINEL;
      else process.env.AUTOSTACK_PARENT_SENTINEL = previous;
    }

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      args: ["$(touch should-not-exist)", "; exit 91"],
      inherited: null,
      exact: "present"
    });
  });

  test("terminates a process that exceeds its duration bound with a static typed error", async () => {
    const runner = new BoundedProcessRunner({ timeoutMs: 25, maximumOutputBytes: 64 * 1024 });
    const promise = runner.run({
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10_000)"],
      cwd: tmpdir(),
      environment: []
    });

    await expect(promise).rejects.toMatchObject({
      name: "ProcessRunError",
      code: "timed_out",
      message: "The process exceeded its duration limit."
    });
  });

  test("terminates a process before buffering output beyond its aggregate byte bound", async () => {
    const runner = new BoundedProcessRunner({ timeoutMs: 5_000, maximumOutputBytes: 1_024 });
    const promise = runner.run({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(4096))"],
      cwd: tmpdir(),
      environment: []
    });

    await expect(promise).rejects.toMatchObject({
      name: "ProcessRunError",
      code: "output_limit",
      message: "The process exceeded its output limit."
    });
  });

  test("rejects malformed requests before launch with bounded diagnostics", async () => {
    const runner = new BoundedProcessRunner({ timeoutMs: 5_000, maximumOutputBytes: 1_024 });
    await expect(
      runner.run({
        executable: process.execPath,
        args: ["contains\0nul"],
        cwd: tmpdir(),
        environment: []
      })
    ).rejects.toEqual(
      expect.objectContaining({
        name: "ProcessRunError",
        code: "invalid_request",
        message: "The process request is invalid."
      })
    );
    expect(new ProcessRunError("invalid_request", "attacker-controlled")).toMatchObject({
      code: "invalid_request",
      message: "The process request is invalid."
    });
    expect(new ProcessRunError("unknown" as ProcessRunError["code"])).toMatchObject({
      code: "invalid_request",
      message: "The process request is invalid."
    });
  });

  test.each([
    ["zero timeout", { timeoutMs: 0, maximumOutputBytes: 1_024 }],
    ["excess timeout", { timeoutMs: 120_001, maximumOutputBytes: 1_024 }],
    ["zero output", { timeoutMs: 1_000, maximumOutputBytes: 0 }],
    ["excess output", { timeoutMs: 1_000, maximumOutputBytes: 16 * 1024 * 1024 + 1 }]
  ])("rejects invalid constructor bounds: %s", (_name, options) => {
    expect(() => new BoundedProcessRunner(options)).toThrow(
      expect.objectContaining({ code: "invalid_request" })
    );
  });

  test.each([
    ["relative executable", { executable: "node", args: [], cwd: tmpdir(), environment: [] }],
    ["relative cwd", { executable: process.execPath, args: [], cwd: "relative", environment: [] }],
    [
      "too many args",
      {
        executable: process.execPath,
        args: Array.from({ length: 257 }, () => "x"),
        cwd: tmpdir(),
        environment: []
      }
    ],
    [
      "oversized arg",
      { executable: process.execPath, args: ["x".repeat(8_193)], cwd: tmpdir(), environment: [] }
    ],
    [
      "invalid environment entry",
      { executable: process.execPath, args: [], cwd: tmpdir(), environment: [null] }
    ],
    [
      "invalid environment name",
      {
        executable: process.execPath,
        args: [],
        cwd: tmpdir(),
        environment: [{ name: "1BAD", value: "x" }]
      }
    ],
    [
      "duplicate environment name",
      {
        executable: process.execPath,
        args: [],
        cwd: tmpdir(),
        environment: [
          { name: "DUP", value: "a" },
          { name: "DUP", value: "b" }
        ]
      }
    ],
    [
      "too many environment entries",
      {
        executable: process.execPath,
        args: [],
        cwd: tmpdir(),
        environment: Array.from({ length: 129 }, (_, index) => ({ name: `V${index}`, value: "x" }))
      }
    ],
    [
      "aggregate environment bytes",
      {
        executable: process.execPath,
        args: [],
        cwd: tmpdir(),
        environment: Array.from({ length: 65 }, (_, index) => ({
          name: `V${index}`,
          value: "x".repeat(8_192)
        }))
      }
    ]
  ])("rejects malformed process request: %s", async (_name, request) => {
    const runner = new BoundedProcessRunner({ timeoutMs: 5_000, maximumOutputBytes: 1_024 });
    await expect(runner.run(request as ProcessRunRequest)).rejects.toMatchObject({
      code: "invalid_request",
      message: "The process request is invalid."
    });
  });

  test("returns bounded stderr, nonzero exit codes, and signal exits without shell mediation", async () => {
    const runner = new BoundedProcessRunner({ timeoutMs: 5_000, maximumOutputBytes: 64 * 1024 });
    const nonzero = await runner.run({
      executable: process.execPath,
      args: ["-e", "process.stderr.write('failure'); process.exit(23)"],
      cwd: tmpdir(),
      environment: []
    });
    expect(nonzero).toEqual({ exitCode: 23, signal: null, stdout: "", stderr: "failure" });

    const signaled = await runner.run({
      executable: process.execPath,
      args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
      cwd: tmpdir(),
      environment: []
    });
    expect(signaled).toEqual({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" });
  });

  test("maps a missing executable launch to a static launch error", async () => {
    const runner = new BoundedProcessRunner({ timeoutMs: 5_000, maximumOutputBytes: 1_024 });
    await expect(
      runner.run({
        executable: join(tmpdir(), "autostack-missing-executable"),
        args: [],
        cwd: tmpdir(),
        environment: []
      })
    ).rejects.toMatchObject({
      code: "launch_failed",
      message: "The process could not be launched."
    });
  });

  test("does not trust a caller-constructed process error thrown by a request getter", async () => {
    const runner = new BoundedProcessRunner({ timeoutMs: 5_000, maximumOutputBytes: 1_024 });
    const request = {
      get executable(): string {
        throw new ProcessRunError("timed_out");
      },
      args: [],
      cwd: tmpdir(),
      environment: []
    };

    await expect(runner.run(request)).rejects.toMatchObject({
      code: "invalid_request",
      message: "The process request is invalid."
    });
  });

  test("rematerializes an escaped process failure when a hostile getter replays it", async () => {
    const runner = new BoundedProcessRunner({ timeoutMs: 25, maximumOutputBytes: 1_024 });
    const escaped = await runner
      .run({
        executable: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10_000)"],
        cwd: tmpdir(),
        environment: []
      })
      .catch((error: unknown) => error);
    expect(escaped).toBeInstanceOf(ProcessRunError);
    if (!(escaped instanceof ProcessRunError)) throw new Error("expected process failure");
    Reflect.set(escaped, "code", "output_limit");
    Reflect.set(escaped, "message", "attacker-controlled");

    const replayed = await runner
      .run({
        get executable(): string {
          throw escaped;
        },
        args: [],
        cwd: tmpdir(),
        environment: []
      })
      .catch((error: unknown) => error);

    expect(replayed).not.toBe(escaped);
    expect(replayed).toMatchObject({
      code: "invalid_request",
      message: "The process request is invalid."
    });
    expect(Object.isFrozen(replayed)).toBe(true);
  });

  test("bounds Proxy-backed argument and environment copies from one length snapshot", async () => {
    const runner = new BoundedProcessRunner({ timeoutMs: 5_000, maximumOutputBytes: 1_024 });
    const argumentTarget = [
      "-e",
      "process.stdout.write(String(process.argv.slice(1).length))",
      ...Array.from({ length: 255 }, () => "x")
    ];
    let argumentLengthReads = 0;
    const args = new Proxy(argumentTarget, {
      get(target, property, receiver) {
        if (property === "length") {
          argumentLengthReads += 1;
          return argumentLengthReads === 1 ? 256 : target.length;
        }
        return Reflect.get(target, property, receiver);
      }
    });
    const argumentResult = await runner.run({
      executable: process.execPath,
      args,
      cwd: tmpdir(),
      environment: []
    });
    expect(argumentResult.stdout).toBe("254");

    const environmentTarget = [
      ...Array.from({ length: 128 }, (_, index) => ({ name: `SAFE_${index}`, value: "x" })),
      { name: "OVER_LIMIT", value: "copied" }
    ];
    let environmentLengthReads = 0;
    const environment = new Proxy(environmentTarget, {
      get(target, property, receiver) {
        if (property === "length") {
          environmentLengthReads += 1;
          return environmentLengthReads === 1 ? 128 : target.length;
        }
        return Reflect.get(target, property, receiver);
      }
    });
    const environmentResult = await runner.run({
      executable: process.execPath,
      args: ["-e", "process.stdout.write(process.env.OVER_LIMIT ?? 'absent')"],
      cwd: tmpdir(),
      environment
    });
    expect(environmentResult.stdout).toBe("absent");
  });

  test("kills the isolated descendant process group and settles within the timeout bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "autostack-process-tree-"));
    cleanupRoots.push(root);
    const sentinelPath = join(root, "descendant-survived");
    const descendantPidPath = join(root, "descendant.pid");
    const descendantScript =
      `const {writeFileSync}=require('node:fs');` +
      `setTimeout(()=>writeFileSync(${JSON.stringify(sentinelPath)},'survived'),600);` +
      `setTimeout(()=>{},1200);`;
    const parentScript =
      `const {writeFileSync}=require('node:fs');const {spawn}=require('node:child_process');` +
      `const child=spawn(${JSON.stringify(process.execPath)},['-e',${JSON.stringify(descendantScript)}],` +
      `{stdio:['ignore','inherit','inherit']});` +
      `writeFileSync(${JSON.stringify(descendantPidPath)},String(child.pid));setTimeout(()=>{},10000);`;
    const runner = new BoundedProcessRunner({ timeoutMs: 200, maximumOutputBytes: 1_024 });
    const startedAt = Date.now();

    await expect(
      runner.run({
        executable: process.execPath,
        args: ["-e", parentScript],
        cwd: root,
        environment: []
      })
    ).rejects.toMatchObject({ code: "timed_out" });
    const settlementMs = Date.now() - startedAt;
    const descendantPid = Number.parseInt(await readFile(descendantPidPath, "utf8"), 10);
    expect(() => process.kill(descendantPid, 0)).toThrow();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));

    expect(settlementMs).toBeLessThan(800);
    await expect(access(sentinelPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("exposes a static cleanup failure without accepting untrusted diagnostics", () => {
    expect(new ProcessRunError("termination_failed", "attacker-controlled")).toMatchObject({
      code: "termination_failed",
      message: "The process tree could not be proven terminated."
    });
  });

  test("keeps supervising an unreaped process tree after static cleanup-proof failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "autostack-process-supervision-"));
    cleanupRoots.push(root);
    const pidPath = join(root, "child.pid");
    const runner = new BoundedProcessRunner({ timeoutMs: 50, maximumOutputBytes: 1_024 });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    let pid: number | undefined;

    try {
      const promise = runner.run({
        executable: process.execPath,
        args: [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setTimeout(()=>{},10000)`
        ],
        cwd: root,
        environment: []
      });
      await expect(promise).rejects.toMatchObject({
        code: "termination_failed",
        message: "The process tree could not be proven terminated."
      });
      pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
      killSpy.mockRestore();

      expect(await waitForProcessExit(pid)).toBe(true);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      expect(unhandled).toEqual([]);
    } finally {
      killSpy.mockRestore();
      process.off("unhandledRejection", onUnhandled);
      if (pid !== undefined && processIsAlive(pid)) process.kill(pid, "SIGKILL");
    }
  });
});

describe("GitClient inspection", () => {
  test("returns canonical repository identity, exact base commit, dirtiness, and a stable safe-config digest", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    await writeFile(join(fixture.sourcePath, "untracked.txt"), "local-only\n", { mode: 0o600 });
    await configureRepository(fixture, "remote.origin.url", "https://example.test/acme/repo.git");
    const before = await captureSourceCheckoutInvariant(fixture);
    const client = await createClient(fixture);

    const first = await client.inspectRepository(fixtureRequest(fixture));
    const second = await client.inspectRepository(fixtureRequest(fixture));

    expect(first.inspection).toEqual({
      repositoryIdentity: expect.stringMatching(/^local-sha256:[0-9a-f]{64}$/),
      canonicalSourcePath: fixture.sourcePath,
      repositoryCommonDirectory: await fixtureGitDirectory(fixture),
      remoteIdentity: "https://example.test/acme/repo.git",
      resolvedBaseRef: "refs/heads/main",
      sourceCommit: fixture.secondCommit,
      dirty: true,
      diagnostics: ["The source checkout has local changes."]
    });
    expect(first.safeConfigDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toEqual(first);
    expect(await captureSourceCheckoutInvariant(fixture)).toEqual(before);
  });

  test("reopens an unchanged empty private configuration root across client restart", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const firstClient = await createClient(fixture);
    const first = await firstClient.inspectRepository(fixtureRequest(fixture));

    const restartedClient = await createClient(fixture);
    expect(await restartedClient.inspectRepository(fixtureRequest(fixture))).toEqual(first);
  });

  test("reports a removed pinned private configuration directory with its static safety code", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const client = await createClient(fixture);
    await rm(join(fixture.privateConfigRoot, "home"), { recursive: true });

    await expect(client.inspectRepository(fixtureRequest(fixture))).rejects.toMatchObject({
      code: "unsafe_private_config",
      message: "The private Git configuration root is unsafe."
    });
  });

  test.each(["root-entry", "home-entry", "xdg-entry"])(
    "rejects unexpected private configuration state: %s",
    async (variant) => {
      const fixture = await createGitRepository();
      cleanupRoots.push(fixture.root);
      const client = await createClient(fixture);
      const target =
        variant === "root-entry"
          ? join(fixture.privateConfigRoot, "unexpected")
          : join(
              fixture.privateConfigRoot,
              variant === "home-entry" ? "home" : "xdg",
              "unexpected"
            );
      await writeFile(target, "unsafe", { mode: 0o600 });

      await expect(client.inspectRepository(fixtureRequest(fixture))).rejects.toMatchObject({
        code: "unsafe_private_config"
      });
    }
  );

  test("does not create Git configuration directories outside a pre-confined private root", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    await rm(join(fixture.privateConfigRoot, "home"), { recursive: true });
    await rm(join(fixture.privateConfigRoot, "xdg"), { recursive: true });

    await expect(createClient(fixture)).rejects.toMatchObject({ code: "unsafe_private_config" });
    await expect(access(join(fixture.privateConfigRoot, "home"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(access(join(fixture.privateConfigRoot, "xdg"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  test("rejects an ambiguous short ref instead of accepting Git's precedence choice", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    await gitFixtureCommand(fixture.sourcePath, ["tag", "main", fixture.firstCommit]);
    const client = await createClient(fixture);

    await expect(client.inspectRepository(fixtureRequest(fixture))).rejects.toMatchObject({
      code: "ambiguous_ref",
      message: "The requested Git reference is ambiguous."
    });
  });

  test("accepts a credential-free conventional SSH origin without rewriting it", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    await configureRepository(fixture, "remote.origin.url", "git@example.test:acme/repo.git");
    const client = await createClient(fixture);

    const inspected = await client.inspectRepository(fixtureRequest(fixture));
    expect(inspected.inspection.remoteIdentity).toBe("git@example.test:acme/repo.git");
  });

  test("resolves an exact commit request without inventing a symbolic ref", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const client = await createClient(fixture);

    const inspected = await client.inspectRepository({
      sourcePath: fixture.sourcePath,
      baseRef: fixture.firstCommit
    });
    expect(inspected.inspection.resolvedBaseRef).toBe(fixture.firstCommit);
    expect(inspected.inspection.sourceCommit).toBe(fixture.firstCommit);
  });

  test("checks an expected safe-config digest and rejects later config drift", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const client = await createClient(fixture);
    const inspected = await client.inspectRepository(fixtureRequest(fixture));
    await expect(
      client.assertSafeConfigDigest(fixture.sourcePath, inspected.safeConfigDigest)
    ).resolves.toBeUndefined();
    await configureRepository(fixture, "maintenance.auto", "false");
    await expect(
      client.assertSafeConfigDigest(fixture.sourcePath, inspected.safeConfigDigest)
    ).rejects.toMatchObject({ code: "config_changed" });
  });

  test("rejects non-repositories, bare repositories, missing refs, and shallow repositories", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const client = await createClient(fixture);
    const ordinary = join(fixture.root, "ordinary");
    await mkdir(ordinary, { mode: 0o700 });
    await expect(
      client.inspectRepository({ sourcePath: ordinary, baseRef: "main" })
    ).rejects.toMatchObject({
      code: "invalid_repository"
    });
    await expect(
      client.inspectRepository({ sourcePath: fixture.sourcePath, baseRef: "missing-ref" })
    ).rejects.toMatchObject({ code: "missing_ref" });

    const bare = join(fixture.root, "bare.git");
    await gitFixtureCommand(fixture.root, ["init", "--bare", bare]);
    await expect(
      client.inspectRepository({ sourcePath: bare, baseRef: "main" })
    ).rejects.toMatchObject({
      code: "invalid_repository"
    });

    const shallow = join(fixture.root, "shallow");
    await gitFixtureCommand(fixture.root, [
      "clone",
      "--depth=1",
      `file://${fixture.sourcePath}`,
      shallow
    ]);
    await gitFixtureCommand(shallow, ["remote", "remove", "origin"]);
    await expect(
      client.inspectRepository({ sourcePath: shallow, baseRef: "HEAD" })
    ).rejects.toMatchObject({
      code: "shallow_repository"
    });
  });

  test("rejects a source inside the AutoStack managed-worktree root", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const nestedSource = join(fixture.managedWorktreeRoot, "nested-source");
    await gitFixtureCommand(fixture.managedWorktreeRoot, [
      "clone",
      fixture.sourcePath,
      nestedSource
    ]);
    const client = await createClient(fixture);

    await expect(
      client.inspectRepository({ sourcePath: nestedSource, baseRef: "main" })
    ).rejects.toMatchObject({ code: "managed_worktree_source" });
  });

  test("rejects an external linked checkout whose common repository directory is managed", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const managedRepository = join(fixture.managedWorktreeRoot, "internal-repository");
    const externalWorktree = join(fixture.root, "external-linked-worktree");
    await gitFixtureCommand(fixture.managedWorktreeRoot, [
      "clone",
      fixture.sourcePath,
      managedRepository
    ]);
    await gitFixtureCommand(managedRepository, [
      "worktree",
      "add",
      "--detach",
      externalWorktree,
      "HEAD"
    ]);
    await gitFixtureCommand(managedRepository, ["remote", "remove", "origin"]);
    const client = await createClient(fixture);

    await expect(
      client.inspectRepository({ sourcePath: externalWorktree, baseRef: "HEAD" })
    ).rejects.toMatchObject({
      code: "invalid_repository",
      message: "The repository cannot be inspected."
    });
  });

  test("does not trust a caller-constructed path error thrown by an inspection getter", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const client = await createClient(fixture);
    const request = {
      get sourcePath(): string {
        throw new PathPolicyError("managed_worktree_source", "attacker-controlled");
      },
      baseRef: "main"
    };

    await expect(client.inspectRepository(request)).rejects.toMatchObject({
      code: "invalid_request",
      message: "The Git operation request is invalid."
    });
  });

  test("rematerializes an escaped Git failure when a hostile getter replays it", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const client = await createClient(fixture);
    const escaped = await client
      .inspectRepository({ sourcePath: fixture.sourcePath, baseRef: "missing-ref" })
      .catch((error: unknown) => error);
    expect(escaped).toBeInstanceOf(GitClientError);
    if (!(escaped instanceof GitClientError)) throw new Error("expected Git failure");
    Reflect.set(escaped, "code", "unsafe_remote");
    Reflect.set(escaped, "message", "attacker-controlled");

    const replayed = await client
      .inspectRepository({
        get sourcePath(): string {
          throw escaped;
        },
        baseRef: fixture.baseBranch
      })
      .catch((error: unknown) => error);

    expect(replayed).not.toBe(escaped);
    expect(replayed).toMatchObject({
      code: "invalid_request",
      message: "The Git operation request is invalid."
    });
    expect(Object.isFrozen(replayed)).toBe(true);
  });

  test.each([
    ["include.path", "/tmp/hostile-config"],
    ["includeIf.gitdir:/tmp/**.path", "/tmp/hostile-config"],
    ["core.hooksPath", "/tmp/hostile-hooks"],
    ["core.fsmonitor", "/tmp/hostile-fsmonitor"],
    ["core.attributesFile", "/tmp/hostile-attributes"],
    ["filter.evil.clean", "/tmp/hostile-filter"],
    ["filter.evil.smudge", "/tmp/hostile-filter"],
    ["filter.evil.process", "/tmp/hostile-filter"],
    ["extensions.partialClone", "origin"],
    ["remote.origin.promisor", "true"],
    ["remote.origin.partialCloneFilter", "blob:none"],
    ["core.sshCommand", "/tmp/hostile-ssh"],
    ["protocol.ext.allow", "always"],
    ["protocol.allow", "always"],
    ["remote.origin.uploadpack", "/tmp/hostile-upload-pack"],
    ["remote.origin.receivepack", "/tmp/hostile-receive-pack"],
    ["remote.origin.vcs", "hostile-helper"],
    ["credential.helper", "/tmp/hostile-credential-helper"],
    ["url.ext::/tmp/hostile.insteadOf", "https://example.test/"]
  ])("rejects unsafe local config key %s without running it", async (key, value) => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    await configureRepository(fixture, key, value);
    const client = await createClient(fixture);

    await expect(client.inspectRepository(fixtureRequest(fixture))).rejects.toMatchObject({
      code: "unsafe_repository",
      message: "The repository configuration is unsafe."
    });
  });

  test("rejects lossy replacement characters in local config instead of digesting normalized bytes", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    await configureRepository(fixture, "maintenance.test", "contains-�-replacement");
    const client = await createClient(fixture);

    await expect(client.inspectRepository(fixtureRequest(fixture))).rejects.toMatchObject({
      code: "unsafe_repository",
      message: "The repository configuration is unsafe."
    });
  });

  test("rejects credential-bearing HTTP remotes without reflecting the remote", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    await configureRepository(
      fixture,
      "remote.origin.url",
      "https://ghp_abcdefghijklmnopqrstuvwxyz@example.test/acme/repo.git"
    );
    const client = await createClient(fixture);

    await expect(client.inspectRepository(fixtureRequest(fixture))).rejects.toEqual(
      expect.objectContaining({
        code: "unsafe_remote",
        message: "The repository remote is unsafe."
      })
    );
  });

  test.each([
    "https://example.test/acme/repo.git?access_token=ordinary-looking-value",
    "https://example.test/acme/repo.git#credential",
    "ssh://not-git@example.test/acme/repo.git",
    "https://user@example.test/acme/repo.git"
  ])("rejects remote userinfo or credential-bearing URL components", async (remote) => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    await configureRepository(fixture, "remote.origin.url", remote);
    const client = await createClient(fixture);

    await expect(client.inspectRepository(fixtureRequest(fixture))).rejects.toMatchObject({
      code: "unsafe_remote",
      message: "The repository remote is unsafe."
    });
  });

  test.each([
    "/tmp/local-repository",
    "../relative-repository",
    "file:///tmp/local-repository",
    "git://example.test/acme/repo.git",
    "ext::/tmp/hostile-transport",
    "hg::https://example.test/acme/repo"
  ])("rejects a non-explicitly-safe remote transport %s", async (remote) => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    await configureRepository(fixture, "remote.origin.url", remote);
    const client = await createClient(fixture);

    await expect(client.inspectRepository(fixtureRequest(fixture))).rejects.toMatchObject({
      code: "unsafe_remote",
      message: "The repository remote is unsafe."
    });
  });

  test("rejects a promisor repository with a missing object without invoking its transport", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const sentinel = await createSentinelExecutable(fixture, "promisor-transport");
    const object = await gitFixtureCommand(fixture.sourcePath, ["rev-parse", "HEAD:tracked.txt"]);
    await configureRepository(fixture, "remote.origin.url", `ext::${sentinel.executablePath}`);
    await configureRepository(fixture, "remote.origin.promisor", "true");
    await configureRepository(fixture, "extensions.partialClone", "origin");
    await rm(join(fixture.sourcePath, ".git", "objects", object.slice(0, 2), object.slice(2)));
    const client = await createClient(fixture);

    await expect(client.inspectRepository(fixtureRequest(fixture))).rejects.toMatchObject({
      code: "unsafe_repository"
    });
    await expect(access(sentinel.sentinelPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each(["url", "pushurl"])(
    "rejects a credential-bearing dotted remote subsection %s",
    async (suffix) => {
      const fixture = await createGitRepository();
      cleanupRoots.push(fixture.root);
      await configureRepository(
        fixture,
        `remote.evil.name.${suffix}`,
        "https://token-user@example.test/acme/repo.git"
      );
      const client = await createClient(fixture);

      await expect(client.inspectRepository(fixtureRequest(fixture))).rejects.toMatchObject({
        code: "unsafe_remote",
        message: "The repository remote is unsafe."
      });
    }
  );

  test("does not run configured hook, filter, or fsmonitor sentinels while rejecting them", async () => {
    for (const [key, executableName] of [
      ["core.hooksPath", "hooks"],
      ["core.fsmonitor", "fsmonitor"],
      ["filter.evil.smudge", "smudge"]
    ] as const) {
      const fixture = await createGitRepository();
      cleanupRoots.push(fixture.root);
      const sentinel = await createSentinelExecutable(fixture, executableName);
      await configureRepository(fixture, key, sentinel.executablePath);
      const client = await createClient(fixture);
      await expect(client.inspectRepository(fixtureRequest(fixture))).rejects.toMatchObject({
        code: "unsafe_repository"
      });
      await expect(access(sentinel.sentinelPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  test("rejects worktree-scoped configuration before a hidden fsmonitor sentinel can run", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const sentinel = await createSentinelExecutable(fixture, "worktree-config-fsmonitor");
    await configureRepository(fixture, "extensions.worktreeConfig", "true");
    await gitFixtureCommand(fixture.sourcePath, [
      "config",
      "--worktree",
      "core.fsmonitor",
      sentinel.executablePath
    ]);
    const client = await createClient(fixture);

    await expect(client.inspectRepository(fixtureRequest(fixture))).rejects.toMatchObject({
      code: "unsafe_repository",
      message: "The repository configuration is unsafe."
    });
    await expect(access(sentinel.sentinelPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("uses the injected runner with a fixed safe environment and hardened Git arguments", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const delegate = new BoundedProcessRunner({
      timeoutMs: 10_000,
      maximumOutputBytes: 4 * 1024 * 1024
    });
    const requests: ProcessRunRequest[] = [];
    const processRunner: ProcessRunner = {
      async run(request) {
        requests.push(request);
        return delegate.run(request);
      }
    };
    const client = await createClient(fixture, processRunner);
    await client.inspectRepository(fixtureRequest(fixture));

    expect(requests.length).toBeGreaterThan(4);
    for (const request of requests) {
      expect(request.executable).toBe("/usr/bin/git");
      expect(request.args).toContain("--no-optional-locks");
      expect(request.args).toContain("--no-pager");
      expect(
        Object.fromEntries(request.environment.map(({ name, value }) => [name, value]))
      ).toEqual({
        PATH: "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
        TMPDIR: "/tmp",
        HOME: join(fixture.privateConfigRoot, "home"),
        XDG_CONFIG_HOME: join(fixture.privateConfigRoot, "xdg"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
        GIT_NO_LAZY_FETCH: "1"
      });
      expect(
        request.environment.some(({ name }) => /^(?:GIT_DIR|NODE_OPTIONS|DYLD_)/.test(name))
      ).toBe(false);
    }
  });

  test("binds the injected runner method before the first filesystem await", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const delegate = new BoundedProcessRunner({
      timeoutMs: 10_000,
      maximumOutputBytes: 4 * 1024 * 1024
    });
    const processRunner: ProcessRunner = {
      run: delegate.run.bind(delegate)
    };
    const options = {
      get managedWorktreeRoot(): string {
        queueMicrotask(() => {
          processRunner.run = async () => ({
            exitCode: null,
            signal: null,
            stdout: "",
            stderr: ""
          });
        });
        return fixture.managedWorktreeRoot;
      },
      privateConfigRoot: fixture.privateConfigRoot,
      trustedGitExecutable: "/usr/bin/git",
      processRunner
    };

    const client = await GitClient.create(options);
    await expect(client.inspectRepository(fixtureRequest(fixture))).resolves.toMatchObject({
      inspection: { sourceCommit: fixture.secondCommit }
    });
  });

  test("rejects Git versions without the no-lazy-fetch capability", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const clientPromise = createClient(fixture, {
      async run() {
        return { exitCode: 0, signal: null, stdout: "git version 2.44.0\n", stderr: "" };
      }
    });

    await expect(clientPromise).rejects.toMatchObject({
      code: "unsafe_git_executable",
      message: "The Git executable is unsafe."
    });
  });
});

describe("GitClient manager operations", () => {
  test("ignores unadmitted submodules without executing their local configuration", async () => {
    const fixture = await createGitRepository();
    const submodule = await createGitRepository();
    cleanupRoots.push(fixture.root, submodule.root);
    await gitFixtureCommand(fixture.sourcePath, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      submodule.sourcePath,
      "vendor/module"
    ]);
    await gitFixtureCommand(fixture.sourcePath, ["commit", "-am", "add submodule"]);
    const sentinel = await createSentinelExecutable(fixture, "submodule-fsmonitor");
    await gitFixtureCommand(join(fixture.sourcePath, "vendor", "module"), [
      "config",
      "--local",
      "core.fsmonitor",
      sentinel.executablePath
    ]);
    const client = await createClient(fixture);

    await expect(client.inspectRepository(fixtureRequest(fixture))).resolves.toMatchObject({
      inspection: { dirty: false }
    });
    await expect(access(sentinel.sentinelPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("parses NUL-delimited worktree records without treating spaces or newlines as separators", () => {
    const records = parseWorktreePorcelainZ(
      "worktree /tmp/source with space\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/main\0locked AutoStack reason\0\0" +
        "worktree /tmp/line\nfeed\0HEAD 2222222222222222222222222222222222222222\0detached\0\0"
    );
    expect(records).toEqual([
      {
        path: "/tmp/source with space",
        head: "1111111111111111111111111111111111111111",
        branch: "refs/heads/main",
        lockedReason: "AutoStack reason",
        bare: false,
        detached: false
      },
      {
        path: "/tmp/line\nfeed",
        head: "2222222222222222222222222222222222222222",
        bare: false,
        detached: true
      }
    ]);
  });

  test("rejects a non-bare worktree record that is neither branch-attached nor detached", () => {
    expect(() =>
      parseWorktreePorcelainZ("worktree /tmp/a\0HEAD 1111111111111111111111111111111111111111\0\0")
    ).toThrow(
      expect.objectContaining({
        code: "malformed_output",
        message: "Git returned malformed output."
      })
    );
  });

  test.each([
    "not terminated",
    "\0\0",
    "worktree /tmp/a\0HEAD 1111111111111111111111111111111111111111\0HEAD 2222222222222222222222222222222222222222\0\0",
    "worktree /tmp/a\0HEAD 1111111111111111111111111111111111111111\0future value\0\0",
    "worktree relative\0HEAD 1111111111111111111111111111111111111111\0\0",
    "worktree /tmp/a\0HEAD invalid\0\0",
    "worktree /tmp/a\0HEAD 1111111111111111111111111111111111111111\0branch main\0\0",
    `worktree /tmp/a\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/${"a".repeat(512)}\0\0`,
    `worktree /tmp/a\0HEAD 1111111111111111111111111111111111111111\0locked ${"a".repeat(1_025)}\0\0`,
    `worktree /tmp/a\0HEAD 1111111111111111111111111111111111111111\0prunable ${"a".repeat(1_025)}\0\0`,
    "worktree /tmp/a\0bare unexpected\0\0",
    "worktree /tmp/a\0HEAD 1111111111111111111111111111111111111111\0detached unexpected\0\0",
    "HEAD 1111111111111111111111111111111111111111\0\0",
    "worktree /tmp/a\0branch refs/heads/main\0\0",
    "worktree /tmp/a\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/main\0detached\0\0",
    "worktree /tmp/a\0HEAD 1111111111111111111111111111111111111111\0\0worktree /tmp/a\0HEAD 2222222222222222222222222222222222222222\0\0",
    "worktree /tmp/a\0bare\0HEAD 1111111111111111111111111111111111111111\0\0"
  ])("rejects duplicate, unknown, or structurally malformed worktree output", (output) => {
    expect(() => parseWorktreePorcelainZ(output)).toThrow(
      expect.objectContaining({
        code: "malformed_output",
        message: "Git returned malformed output."
      })
    );
  });

  test("rejects worktree output before parsing beyond its byte bound", () => {
    expect(() =>
      parseWorktreePorcelainZ(
        `worktree /tmp/${"x".repeat(4 * 1024 * 1024)}\0HEAD 1111111111111111111111111111111111111111\0\0`
      )
    ).toThrow(expect.objectContaining({ code: "malformed_output" }));
  });

  test("rejects replacement characters in worktree output to avoid lossy path parsing", () => {
    expect(() =>
      parseWorktreePorcelainZ("worktree /tmp/�\0HEAD 1111111111111111111111111111111111111111\0\0")
    ).toThrow(expect.objectContaining({ code: "malformed_output" }));
  });

  test("parses detached, bare, empty-lock, and prunable worktree states", () => {
    expect(
      parseWorktreePorcelainZ(
        "worktree /tmp/detached\0HEAD 1111111111111111111111111111111111111111\0detached\0locked\0prunable stale\0\0" +
          "worktree /tmp/bare.git\0bare\0\0"
      )
    ).toEqual([
      {
        path: "/tmp/detached",
        head: "1111111111111111111111111111111111111111",
        lockedReason: "",
        prunableReason: "stale",
        bare: false,
        detached: true
      },
      { path: "/tmp/bare.git", bare: true, detached: false }
    ]);
  });

  test.each([
    "refs/heads/../escape",
    "refs/heads/.hidden",
    "refs/heads/autostack//escape",
    "refs/heads/autostack/task.lock",
    "refs/heads/autostack/task..escape",
    "refs/heads/autostack/task~escape"
  ])("rejects a malformed worktree branch ref %s", (branch) => {
    expect(() =>
      parseWorktreePorcelainZ(
        `worktree /tmp/a\0HEAD 1111111111111111111111111111111111111111\0branch ${branch}\0\0`
      )
    ).toThrow(expect.objectContaining({ code: "malformed_output" }));
  });

  test("preserves an exact valid AutoStack branch from worktree porcelain", () => {
    expect(
      parseWorktreePorcelainZ(
        "worktree /tmp/a\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/autostack/run-safe\0\0"
      )
    ).toEqual([
      {
        path: "/tmp/a",
        head: "1111111111111111111111111111111111111111",
        branch: "refs/heads/autostack/run-safe",
        bare: false,
        detached: false
      }
    ]);
  });

  test("preserves malformed worktree output classification through listWorktrees", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const delegate = new BoundedProcessRunner({
      timeoutMs: 10_000,
      maximumOutputBytes: 4 * 1024 * 1024
    });
    const processRunner: ProcessRunner = {
      async run(request) {
        if (
          request.args.slice(-4).join("\0") === ["worktree", "list", "--porcelain", "-z"].join("\0")
        ) {
          return { exitCode: 0, signal: null, stdout: "malformed", stderr: "" };
        }
        return delegate.run(request);
      }
    };
    const client = await createClient(fixture, processRunner);

    await expect(client.listWorktrees(fixture.sourcePath)).rejects.toMatchObject({
      code: "malformed_output",
      message: "Git returned malformed output."
    });
  });

  test("preserves malformed branch-query output classification through addLockedWorktree", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const delegate = new BoundedProcessRunner({
      timeoutMs: 10_000,
      maximumOutputBytes: 4 * 1024 * 1024
    });
    const branch = "autostack/nested-add";
    const processRunner: ProcessRunner = {
      async run(request) {
        if (
          request.args.slice(-5).join("\0") ===
          ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${branch}`].join(
            "\0"
          )
        ) {
          return { exitCode: 0, signal: null, stdout: "�\n", stderr: "" };
        }
        return delegate.run(request);
      }
    };
    const client = await createClient(fixture, processRunner);
    const inspected = await client.inspectRepository(fixtureRequest(fixture));
    const worktreePath = join(fixture.managedWorktreeRoot, "nested-add");

    await expect(
      client.addLockedWorktree({
        sourcePath: fixture.sourcePath,
        expectedSafeConfigDigest: inspected.safeConfigDigest,
        branch,
        worktreePath,
        commit: fixture.firstCommit
      })
    ).rejects.toMatchObject({
      code: "malformed_output",
      message: "Git returned malformed output."
    });
    await expect(access(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("preserves malformed worktree output classification through recovery attachment", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const branch = "autostack/nested-attach";
    await gitFixtureCommand(fixture.sourcePath, ["branch", branch, fixture.firstCommit]);
    const delegate = new BoundedProcessRunner({
      timeoutMs: 10_000,
      maximumOutputBytes: 4 * 1024 * 1024
    });
    const processRunner: ProcessRunner = {
      async run(request) {
        if (
          request.args.slice(-4).join("\0") === ["worktree", "list", "--porcelain", "-z"].join("\0")
        ) {
          return { exitCode: 0, signal: null, stdout: "malformed", stderr: "" };
        }
        return delegate.run(request);
      }
    };
    const client = await createClient(fixture, processRunner);
    const inspected = await client.inspectRepository(fixtureRequest(fixture));
    const worktreePath = join(fixture.managedWorktreeRoot, "nested-attach");

    await expect(
      client.attachExistingLockedWorktree({
        sourcePath: fixture.sourcePath,
        expectedSafeConfigDigest: inspected.safeConfigDigest,
        branch,
        worktreePath,
        commit: fixture.firstCommit
      })
    ).rejects.toMatchObject({
      code: "malformed_output",
      message: "Git returned malformed output."
    });
    await expect(access(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("adds, inspects, unlocks, and removes only the exact locked worktree while retaining its branch", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const client = await createClient(fixture);
    const inspected = await client.inspectRepository(fixtureRequest(fixture));
    const worktreePath = join(fixture.managedWorktreeRoot, "repo", "environment");
    await mkdir(join(fixture.managedWorktreeRoot, "repo"), { mode: 0o700 });
    const hook = await createSentinelExecutable(fixture, "post-checkout-default");
    await copyFile(hook.executablePath, join(fixture.sourcePath, ".git", "hooks", "post-checkout"));
    await chmod(join(fixture.sourcePath, ".git", "hooks", "post-checkout"), 0o700);
    const before = await captureSourceCheckoutInvariant(fixture);

    await client.addLockedWorktree({
      sourcePath: fixture.sourcePath,
      expectedSafeConfigDigest: inspected.safeConfigDigest,
      branch: "autostack/run-task",
      worktreePath,
      commit: fixture.firstCommit
    });
    const records = await client.listWorktrees(fixture.sourcePath);
    expect(records).toContainEqual(
      expect.objectContaining({
        path: worktreePath,
        head: fixture.firstCommit,
        branch: "refs/heads/autostack/run-task",
        lockedReason: "AutoStack"
      })
    );
    expect(await client.inspectWorktree(worktreePath)).toEqual({
      head: fixture.firstCommit,
      branch: "autostack/run-task",
      dirty: false
    });
    await client.unlockWorktree({ sourcePath: fixture.sourcePath, worktreePath });
    await client.removeWorktree({ sourcePath: fixture.sourcePath, worktreePath });
    expect(await client.resolveBranchCommit(fixture.sourcePath, "autostack/run-task")).toBe(
      fixture.firstCommit
    );
    await expect(access(hook.sentinelPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await captureSourceCheckoutInvariant(fixture)).toEqual(before);
  });

  test("snapshots every managed request field before asynchronous path validation", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const client = await createClient(fixture);
    const inspected = await client.inspectRepository(fixtureRequest(fixture));
    const worktreePath = join(fixture.managedWorktreeRoot, "snapshot-request");
    await client.addLockedWorktree({
      sourcePath: fixture.sourcePath,
      expectedSafeConfigDigest: inspected.safeConfigDigest,
      branch: "autostack/snapshot-request",
      worktreePath,
      commit: fixture.firstCommit
    });
    let mutableWorktreePath = worktreePath;
    const request = {
      get sourcePath(): string {
        queueMicrotask(() => {
          mutableWorktreePath = "relative-after-await";
        });
        return fixture.sourcePath;
      },
      get worktreePath(): string {
        return mutableWorktreePath;
      }
    };

    await expect(client.unlockWorktree(request)).resolves.toBeUndefined();
    await expect(
      client.removeWorktree({ sourcePath: fixture.sourcePath, worktreePath })
    ).resolves.toBeUndefined();
  });

  test("reports an existing product branch or occupied branch as a typed creation conflict", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const client = await createClient(fixture);
    const inspected = await client.inspectRepository(fixtureRequest(fixture));
    await gitFixtureCommand(fixture.sourcePath, [
      "branch",
      "autostack/existing",
      fixture.firstCommit
    ]);

    await expect(
      client.addLockedWorktree({
        sourcePath: fixture.sourcePath,
        expectedSafeConfigDigest: inspected.safeConfigDigest,
        branch: "autostack/existing",
        worktreePath: join(fixture.managedWorktreeRoot, "existing"),
        commit: fixture.firstCommit
      })
    ).rejects.toMatchObject({ code: "branch_conflict" });
  });

  test("rechecks the safe-config digest immediately before worktree creation", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const client = await createClient(fixture);
    const inspected = await client.inspectRepository(fixtureRequest(fixture));
    await configureRepository(fixture, "maintenance.auto", "false");

    await expect(
      client.addLockedWorktree({
        sourcePath: fixture.sourcePath,
        expectedSafeConfigDigest: inspected.safeConfigDigest,
        branch: "autostack/config-race",
        worktreePath: join(fixture.managedWorktreeRoot, "config-race"),
        commit: fixture.secondCommit
      })
    ).rejects.toMatchObject({
      code: "config_changed",
      message: "The repository configuration changed."
    });
  });

  test("serializes worktree mutations before any repository admission work", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const delegate = new BoundedProcessRunner({
      timeoutMs: 10_000,
      maximumOutputBytes: 4 * 1024 * 1024
    });
    let firstMutationEntered!: () => void;
    const firstEntered = new Promise<void>((resolvePromise) => {
      firstMutationEntered = resolvePromise;
    });
    let secondMutationEntered!: () => void;
    const secondEntered = new Promise<void>((resolvePromise) => {
      secondMutationEntered = resolvePromise;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    let mutationCalls = 0;
    const processRunner: ProcessRunner = {
      async run(request) {
        if (request.args.includes("worktree") && request.args.includes("add")) {
          mutationCalls += 1;
          if (mutationCalls === 1) {
            firstMutationEntered();
            await firstGate;
          } else {
            secondMutationEntered();
          }
        }
        return delegate.run(request);
      }
    };
    const firstClient = await createClient(fixture, processRunner);
    const secondClient = await createClient(fixture, processRunner);
    const inspected = await firstClient.inspectRepository(fixtureRequest(fixture));
    const first = firstClient.addLockedWorktree({
      sourcePath: fixture.sourcePath,
      expectedSafeConfigDigest: inspected.safeConfigDigest,
      branch: "autostack/serialized-one",
      worktreePath: join(fixture.managedWorktreeRoot, "serialized-one"),
      commit: fixture.firstCommit
    });
    await firstEntered;
    const second = secondClient.addLockedWorktree({
      sourcePath: fixture.sourcePath,
      expectedSafeConfigDigest: inspected.safeConfigDigest,
      branch: "autostack/serialized-two",
      worktreePath: join(fixture.managedWorktreeRoot, "serialized-two"),
      commit: fixture.firstCommit
    });
    const secondReachedBeforeRelease = await Promise.race([
      secondEntered.then(() => true),
      new Promise<false>((resolvePromise) => setTimeout(() => resolvePromise(false), 100))
    ]);
    releaseFirst();
    const settled = await Promise.allSettled([first, second]);

    expect(secondReachedBeforeRelease).toBe(false);
    expect(settled).toEqual([
      expect.objectContaining({ status: "fulfilled" }),
      expect.objectContaining({ status: "fulfilled" })
    ]);
  });

  test("rejects a managed parent identity swap at the final mutation barrier", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const parent = join(fixture.managedWorktreeRoot, "parent-swap");
    await mkdir(parent, { mode: 0o700 });
    const delegate = new BoundedProcessRunner({
      timeoutMs: 10_000,
      maximumOutputBytes: 4 * 1024 * 1024
    });
    let armed = false;
    let localConfigReads = 0;
    const processRunner: ProcessRunner = {
      async run(request) {
        const result = await delegate.run(request);
        if (
          armed &&
          request.args.slice(-5).join("\0") ===
            ["config", "--local", "--null", "--list", "--no-includes"].join("\0")
        ) {
          localConfigReads += 1;
          if (localConfigReads === 4) {
            await rm(parent, { recursive: true });
            await mkdir(parent, { mode: 0o700 });
          }
        }
        return result;
      }
    };
    const client = await createClient(fixture, processRunner);
    const inspected = await client.inspectRepository(fixtureRequest(fixture));
    armed = true;
    const worktreePath = join(parent, "environment");

    await expect(
      client.addLockedWorktree({
        sourcePath: fixture.sourcePath,
        expectedSafeConfigDigest: inspected.safeConfigDigest,
        branch: "autostack/parent-barrier",
        worktreePath,
        commit: fixture.firstCommit
      })
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(access(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects local configuration replaced after Git captured the final mutation check", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const delegate = new BoundedProcessRunner({
      timeoutMs: 10_000,
      maximumOutputBytes: 4 * 1024 * 1024
    });
    let armed = false;
    let localConfigReads = 0;
    const processRunner: ProcessRunner = {
      async run(request) {
        const result = await delegate.run(request);
        if (
          armed &&
          request.args.slice(-5).join("\0") ===
            ["config", "--local", "--null", "--list", "--no-includes"].join("\0")
        ) {
          localConfigReads += 1;
          if (localConfigReads === 4) {
            await configureRepository(fixture, "maintenance.barrier", "changed");
          }
        }
        return result;
      }
    };
    const client = await createClient(fixture, processRunner);
    const inspected = await client.inspectRepository(fixtureRequest(fixture));
    armed = true;
    const worktreePath = join(fixture.managedWorktreeRoot, "config-barrier");

    await expect(
      client.addLockedWorktree({
        sourcePath: fixture.sourcePath,
        expectedSafeConfigDigest: inspected.safeConfigDigest,
        branch: "autostack/config-barrier",
        worktreePath,
        commit: fixture.firstCommit
      })
    ).rejects.toMatchObject({ code: "unsafe_repository" });
    await expect(access(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reports dirtiness inside a managed worktree without modifying the source checkout", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const client = await createClient(fixture);
    const inspected = await client.inspectRepository(fixtureRequest(fixture));
    const worktreePath = join(fixture.managedWorktreeRoot, "dirty-worktree");
    const before = await captureSourceCheckoutInvariant(fixture);
    await client.addLockedWorktree({
      sourcePath: fixture.sourcePath,
      expectedSafeConfigDigest: inspected.safeConfigDigest,
      branch: "autostack/dirty-worktree",
      worktreePath,
      commit: fixture.firstCommit
    });
    await writeFile(join(worktreePath, "dirty.txt"), "dirty\n", { mode: 0o600 });

    expect(await client.inspectWorktree(worktreePath)).toEqual({
      head: fixture.firstCommit,
      branch: "autostack/dirty-worktree",
      dirty: true
    });
    expect(await captureSourceCheckoutInvariant(fixture)).toEqual(before);
  });

  test("rejects existing or symlinked worktree targets before Git mutation", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const client = await createClient(fixture);
    const inspected = await client.inspectRepository(fixtureRequest(fixture));
    const existing = join(fixture.managedWorktreeRoot, "existing-target");
    const symlinkTarget = join(fixture.managedWorktreeRoot, "symlink-target");
    await mkdir(existing, { mode: 0o700 });
    await symlink(fixture.sourcePath, symlinkTarget);

    for (const [branch, worktreePath] of [
      ["autostack/existing-target", existing],
      ["autostack/symlink-target", symlinkTarget]
    ] as const) {
      await expect(
        client.addLockedWorktree({
          sourcePath: fixture.sourcePath,
          expectedSafeConfigDigest: inspected.safeConfigDigest,
          branch,
          worktreePath,
          commit: fixture.firstCommit
        })
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(await client.resolveBranchCommit(fixture.sourcePath, branch)).toBeUndefined();
    }
  });

  test("attaches an exact unoccupied recovery branch without recreating it", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const client = await createClient(fixture);
    const inspected = await client.inspectRepository(fixtureRequest(fixture));
    await gitFixtureCommand(fixture.sourcePath, [
      "branch",
      "autostack/recovered-task",
      fixture.firstCommit
    ]);
    const hook = await createSentinelExecutable(fixture, "post-checkout-recovery");
    await copyFile(hook.executablePath, join(fixture.sourcePath, ".git", "hooks", "post-checkout"));
    await chmod(join(fixture.sourcePath, ".git", "hooks", "post-checkout"), 0o700);
    const before = await captureSourceCheckoutInvariant(fixture);
    const worktreePath = join(fixture.managedWorktreeRoot, "recovered-task");

    await client.attachExistingLockedWorktree({
      sourcePath: fixture.sourcePath,
      expectedSafeConfigDigest: inspected.safeConfigDigest,
      branch: "autostack/recovered-task",
      worktreePath,
      commit: fixture.firstCommit
    });

    expect(await client.inspectWorktree(worktreePath)).toEqual({
      head: fixture.firstCommit,
      branch: "autostack/recovered-task",
      dirty: false
    });
    await client.unlockWorktree({ sourcePath: fixture.sourcePath, worktreePath });
    await client.removeWorktree({ sourcePath: fixture.sourcePath, worktreePath });
    await expect(access(hook.sentinelPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await captureSourceCheckoutInvariant(fixture)).toEqual(before);
  });

  test("rejects unsafe config before status, unlock, or removal and never runs its sentinel", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const client = await createClient(fixture);
    const inspected = await client.inspectRepository(fixtureRequest(fixture));
    const worktreePath = join(fixture.managedWorktreeRoot, "unsafe-lifecycle");
    await client.addLockedWorktree({
      sourcePath: fixture.sourcePath,
      expectedSafeConfigDigest: inspected.safeConfigDigest,
      branch: "autostack/unsafe-lifecycle",
      worktreePath,
      commit: fixture.firstCommit
    });
    const sentinel = await createSentinelExecutable(fixture, "lifecycle-fsmonitor");
    await configureRepository(fixture, "core.fsmonitor", sentinel.executablePath);

    await expect(client.inspectWorktree(worktreePath)).rejects.toMatchObject({
      code: "unsafe_repository"
    });
    await expect(
      client.unlockWorktree({ sourcePath: fixture.sourcePath, worktreePath })
    ).rejects.toMatchObject({ code: "unsafe_repository" });
    await expect(
      client.removeWorktree({ sourcePath: fixture.sourcePath, worktreePath })
    ).rejects.toMatchObject({ code: "unsafe_repository" });
    await expect(access(sentinel.sentinelPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses recovery when the branch commit differs or another worktree occupies the branch", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const client = await createClient(fixture);
    const inspected = await client.inspectRepository(fixtureRequest(fixture));
    await gitFixtureCommand(fixture.sourcePath, [
      "branch",
      "autostack/recovery-conflict",
      fixture.secondCommit
    ]);

    await expect(
      client.attachExistingLockedWorktree({
        sourcePath: fixture.sourcePath,
        expectedSafeConfigDigest: inspected.safeConfigDigest,
        branch: "autostack/recovery-conflict",
        worktreePath: join(fixture.managedWorktreeRoot, "wrong-commit"),
        commit: fixture.firstCommit
      })
    ).rejects.toMatchObject({ code: "branch_conflict" });

    const occupiedPath = join(fixture.managedWorktreeRoot, "occupied");
    await mkdir(join(fixture.managedWorktreeRoot, "occupied-parent"), { mode: 0o700 });
    await gitFixtureCommand(fixture.sourcePath, [
      "worktree",
      "add",
      "--lock",
      "--reason",
      "AutoStack",
      occupiedPath,
      "autostack/recovery-conflict"
    ]);
    await expect(
      client.attachExistingLockedWorktree({
        sourcePath: fixture.sourcePath,
        expectedSafeConfigDigest: inspected.safeConfigDigest,
        branch: "autostack/recovery-conflict",
        worktreePath: join(fixture.managedWorktreeRoot, "also-occupied"),
        commit: fixture.secondCommit
      })
    ).rejects.toMatchObject({ code: "branch_conflict" });
  });

  test("pins an injected Git executable identity and rejects in-place replacement", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const executable = join(fixture.root, "trusted-git");
    await copyFile("/usr/bin/git", executable);
    await chmod(executable, 0o700);
    const client = await GitClient.create({
      managedWorktreeRoot: fixture.managedWorktreeRoot,
      privateConfigRoot: fixture.privateConfigRoot,
      trustedGitExecutable: executable,
      processRunner: {
        async run() {
          return {
            exitCode: 0,
            signal: null,
            stdout: "git version 2.50.1 (AutoStack Test)\n",
            stderr: ""
          };
        }
      }
    });
    await writeFile(executable, "replaced", { mode: 0o700 });

    await expect(client.inspectRepository(fixtureRequest(fixture))).rejects.toMatchObject({
      code: "unsafe_git_executable",
      message: "The Git executable is unsafe."
    });
  });

  test("rejects a missing injected Git executable with the static executable safety code", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);

    await expect(
      GitClient.create({
        managedWorktreeRoot: fixture.managedWorktreeRoot,
        privateConfigRoot: fixture.privateConfigRoot,
        trustedGitExecutable: join(fixture.root, "missing-git")
      })
    ).rejects.toMatchObject({
      code: "unsafe_git_executable",
      message: "The Git executable is unsafe."
    });
  });

  test("reports a removed pinned Git executable with its static safety code", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const executable = join(fixture.root, "trusted-git-removed");
    await copyFile("/usr/bin/git", executable);
    await chmod(executable, 0o700);
    const client = await GitClient.create({
      managedWorktreeRoot: fixture.managedWorktreeRoot,
      privateConfigRoot: fixture.privateConfigRoot,
      trustedGitExecutable: executable,
      processRunner: {
        async run() {
          return {
            exitCode: 0,
            signal: null,
            stdout: "git version 2.50.1 (AutoStack Test)\n",
            stderr: ""
          };
        }
      }
    });
    await rm(executable);

    await expect(client.inspectRepository(fixtureRequest(fixture))).rejects.toMatchObject({
      code: "unsafe_git_executable",
      message: "The Git executable is unsafe."
    });
  });

  test("rejects an injected runner result that exceeds the independent Git output bound", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const client = await createClient(fixture, {
      async run(request) {
        if (request.args.at(-1) === "--version") {
          return { exitCode: 0, signal: null, stdout: "git version 2.50.1\n", stderr: "" };
        }
        return {
          exitCode: 0,
          signal: null,
          stdout: "x".repeat(4 * 1024 * 1024 + 1),
          stderr: ""
        };
      }
    });

    await expect(client.inspectRepository(fixtureRequest(fixture))).rejects.toMatchObject({
      code: "git_failed",
      message: "The Git operation failed."
    });
  });

  test("rejects an impossible injected process exit and signal combination", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const client = await createClient(fixture, {
      async run(request) {
        if (request.args.at(-1) === "--version") {
          return { exitCode: 0, signal: null, stdout: "git version 2.50.1\n", stderr: "" };
        }
        return { exitCode: 0, signal: "SIGTERM", stdout: "", stderr: "" };
      }
    });

    await expect(client.inspectRepository(fixtureRequest(fixture))).rejects.toMatchObject({
      code: "git_failed",
      message: "The Git operation failed."
    });
  });

  test("quarantines the Git session when process-tree termination cannot be proven", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const pidPath = join(fixture.root, "quarantined-child.pid");
    const delegate = new BoundedProcessRunner({
      timeoutMs: 10_000,
      maximumOutputBytes: 4 * 1024 * 1024
    });
    const hangingRunner = new BoundedProcessRunner({
      timeoutMs: 50,
      maximumOutputBytes: 1_024
    });
    let armed = false;
    let armedCalls = 0;
    const processRunner: ProcessRunner = {
      async run(request) {
        if (!armed) return delegate.run(request);
        armedCalls += 1;
        if (armedCalls === 1) {
          return hangingRunner.run({
            executable: process.execPath,
            args: [
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setTimeout(()=>{},10000)`
            ],
            cwd: fixture.root,
            environment: []
          });
        }
        return { exitCode: 1, signal: null, stdout: "", stderr: "blocked test delegate" };
      }
    };
    const client = await createClient(fixture, processRunner);
    const inspected = await client.inspectRepository(fixtureRequest(fixture));
    armed = true;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    let pid: number | undefined;

    try {
      const firstError = await client
        .inspectRepository(fixtureRequest(fixture))
        .catch((error: unknown) => error);
      expect(firstError).toMatchObject({
        code: "unsafe_process_state",
        message: "The Git process state is unsafe."
      });
      pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
      const callsAtQuarantine = armedCalls;
      const secondError = await client
        .addLockedWorktree({
          sourcePath: fixture.sourcePath,
          expectedSafeConfigDigest: inspected.safeConfigDigest,
          branch: "autostack/quarantined",
          worktreePath: join(fixture.managedWorktreeRoot, "quarantined"),
          commit: fixture.firstCommit
        })
        .catch((error: unknown) => error);

      expect(secondError).toMatchObject({
        code: "unsafe_process_state",
        message: "The Git process state is unsafe."
      });
      expect(armedCalls).toBe(callsAtQuarantine);
      killSpy.mockRestore();
      expect(await waitForProcessExit(pid)).toBe(true);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      expect(unhandled).toEqual([]);
    } finally {
      killSpy.mockRestore();
      process.off("unhandledRejection", onUnhandled);
      if (pid !== undefined && processIsAlive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  test("holds queued operations behind process quarantine before caller access or delegation", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const pidPath = join(fixture.root, "queued-quarantine-child.pid");
    const queuedWorktreePath = join(fixture.managedWorktreeRoot, "queued-quarantine");
    const delegate = new BoundedProcessRunner({
      timeoutMs: 10_000,
      maximumOutputBytes: 4 * 1024 * 1024
    });
    const hangingRunner = new BoundedProcessRunner({
      timeoutMs: 50,
      maximumOutputBytes: 1_024
    });
    let armed = false;
    let armedCalls = 0;
    let signalFirstDelegation!: () => void;
    const firstDelegated = new Promise<void>((resolvePromise) => {
      signalFirstDelegation = resolvePromise;
    });
    const processRunner: ProcessRunner = {
      async run(request) {
        if (!armed) return delegate.run(request);
        armedCalls += 1;
        if (armedCalls === 1) {
          signalFirstDelegation();
          return hangingRunner.run({
            executable: process.execPath,
            args: [
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setTimeout(()=>{},10000)`
            ],
            cwd: fixture.root,
            environment: []
          });
        }
        return delegate.run(request);
      }
    };
    const client = await createClient(fixture, processRunner);
    const inspected = await client.inspectRepository(fixtureRequest(fixture));
    armed = true;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    let getterReads = 0;
    let pid: number | undefined;

    try {
      const firstOperation = client
        .inspectRepository(fixtureRequest(fixture))
        .catch((error: unknown) => error);
      await firstDelegated;
      const queuedOperation = client
        .addLockedWorktree({
          get sourcePath(): string {
            getterReads += 1;
            return fixture.sourcePath;
          },
          get expectedSafeConfigDigest(): string {
            getterReads += 1;
            return inspected.safeConfigDigest;
          },
          get branch(): string {
            getterReads += 1;
            return "autostack/queued-quarantine";
          },
          get worktreePath(): string {
            getterReads += 1;
            return queuedWorktreePath;
          },
          get commit(): string {
            getterReads += 1;
            return fixture.firstCommit;
          }
        })
        .catch((error: unknown) => error);

      const getterReadsBeforeQuarantine = getterReads;
      const [firstError, queuedError] = await Promise.all([firstOperation, queuedOperation]);
      pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
      killSpy.mockRestore();
      expect(await waitForProcessExit(pid)).toBe(true);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));

      expect(firstError).toMatchObject({
        code: "unsafe_process_state",
        message: "The Git process state is unsafe."
      });
      expect(queuedError).toMatchObject({
        code: "unsafe_process_state",
        message: "The Git process state is unsafe."
      });
      expect(getterReadsBeforeQuarantine).toBe(0);
      expect(getterReads).toBe(0);
      expect(armedCalls).toBe(1);
      await expect(access(queuedWorktreePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(unhandled).toEqual([]);
    } finally {
      killSpy.mockRestore();
      process.off("unhandledRejection", onUnhandled);
      if (pid !== undefined && processIsAlive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  test("rejects non-AutoStack branches and malformed commits before invoking Git", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const client = await createClient(fixture);
    const inspected = await client.inspectRepository(fixtureRequest(fixture));

    await expect(
      client.addLockedWorktree({
        sourcePath: fixture.sourcePath,
        expectedSafeConfigDigest: inspected.safeConfigDigest,
        branch: "main",
        worktreePath: join(fixture.managedWorktreeRoot, "bad"),
        commit: "not-a-commit"
      })
    ).rejects.toEqual(
      expect.objectContaining({
        code: "invalid_request",
        message: "The Git operation request is invalid."
      })
    );
  });

  test("rejects an exact-looking commit that is absent before creating a branch or worktree", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const client = await createClient(fixture);
    const inspected = await client.inspectRepository(fixtureRequest(fixture));

    await expect(
      client.addLockedWorktree({
        sourcePath: fixture.sourcePath,
        expectedSafeConfigDigest: inspected.safeConfigDigest,
        branch: "autostack/missing-commit",
        worktreePath: join(fixture.managedWorktreeRoot, "missing-commit"),
        commit: "0000000000000000000000000000000000000000"
      })
    ).rejects.toMatchObject({
      code: "missing_ref",
      message: "The requested Git reference does not exist."
    });
    expect(
      await client.resolveBranchCommit(fixture.sourcePath, "autostack/missing-commit")
    ).toBeUndefined();
  });

  test("rejects a worktree target outside the pinned managed root before mutation", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const client = await createClient(fixture);
    const inspected = await client.inspectRepository(fixtureRequest(fixture));

    await expect(
      client.addLockedWorktree({
        sourcePath: fixture.sourcePath,
        expectedSafeConfigDigest: inspected.safeConfigDigest,
        branch: "autostack/outside",
        worktreePath: join(fixture.root, "outside-managed-root"),
        commit: fixture.firstCommit
      })
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(
      await client.resolveBranchCommit(fixture.sourcePath, "autostack/outside")
    ).toBeUndefined();
  });

  test("fails closed with a static request error when the pinned managed root disappears", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const client = await createClient(fixture);
    const inspected = await client.inspectRepository(fixtureRequest(fixture));
    await rm(fixture.managedWorktreeRoot, { recursive: true });

    await expect(
      client.addLockedWorktree({
        sourcePath: fixture.sourcePath,
        expectedSafeConfigDigest: inspected.safeConfigDigest,
        branch: "autostack/missing-managed-root",
        worktreePath: join(fixture.managedWorktreeRoot, "missing"),
        commit: fixture.firstCommit
      })
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "The Git operation request is invalid."
    });
  });

  test("maps nonzero Git failures to a static typed diagnostic", async () => {
    const fixture = await createGitRepository();
    cleanupRoots.push(fixture.root);
    const client = await createClient(fixture);

    await expect(
      client.removeWorktree({
        sourcePath: fixture.sourcePath,
        worktreePath: join(fixture.managedWorktreeRoot, "missing")
      })
    ).rejects.toEqual(
      expect.objectContaining({
        name: "GitClientError",
        code: "invalid_request",
        message: "The Git operation request is invalid."
      })
    );
    expect(new GitClientError("git_failed", "attacker-controlled")).toMatchObject({
      code: "git_failed",
      message: "The Git operation failed."
    });
    expect(new GitClientError("unknown" as GitClientError["code"])).toMatchObject({
      code: "invalid_request",
      message: "The Git operation request is invalid."
    });
  });
});
