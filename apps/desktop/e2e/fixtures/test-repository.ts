import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";

export interface SourceInvariant {
  readonly head: string;
  readonly branch: string;
  readonly status: string;
  readonly trackedDigest: string;
  readonly untrackedDigest: string;
  readonly configDigest: string;
  readonly indexDigest: string;
}

export interface TestRepositoryScenario {
  readonly root: string;
  readonly source: string;
  readonly userData: string;
  readonly evidence: string;
  readonly descriptor: string;
  readonly sentinels: readonly string[];
  readonly token: string;
  readonly initial: SourceInvariant;
  writeDescriptor(): Promise<string>;
  capture(): Promise<SourceInvariant>;
  cleanup(): Promise<void>;
}

const run = async (executable: string, args: readonly string[], cwd: string): Promise<string> =>
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: join(cwd, ".fixture-home"),
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(Buffer.concat(output).toString("utf8"));
      else reject(new Error(Buffer.concat(errors).toString("utf8") || `git exited ${code}`));
    });
  });

const digest = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

const fileDigest = async (path: string): Promise<string> => digest(await readFile(path));

const captureInvariant = async (source: string): Promise<SourceInvariant> => ({
  head: (await run("/usr/bin/git", ["rev-parse", "HEAD"], source)).trim(),
  branch: (await run("/usr/bin/git", ["symbolic-ref", "--short", "HEAD"], source)).trim(),
  status: await run(
    "/usr/bin/git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    source
  ),
  trackedDigest: await fileDigest(join(source, "tracked.txt")),
  untrackedDigest: await fileDigest(join(source, "user-untracked.txt")),
  configDigest: await fileDigest(join(source, ".git", "config")),
  indexDigest: await fileDigest(join(source, ".git", "index"))
});

export const createTestRepositoryScenario = async (): Promise<TestRepositoryScenario> => {
  const root = await mkdtemp(join(tmpdir(), "autostack-local-e2e-"));
  await chmod(root, 0o700);
  const source = join(root, "source");
  const userData = join(root, "desktop");
  const evidence = join(root, "evidence");
  const sentinelsRoot = join(root, "sentinels");
  await Promise.all(
    [source, userData, evidence, sentinelsRoot].map(async (path) => {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700);
    })
  );
  await mkdir(join(source, ".fixture-home"), { mode: 0o700 });
  await run("/usr/bin/git", ["init", "--initial-branch=main"], source);
  await run("/usr/bin/git", ["config", "user.name", "AutoStack E2E"], source);
  await run("/usr/bin/git", ["config", "user.email", "e2e@invalid.example"], source);
  await writeFile(join(source, "tracked.txt"), "committed\n", { mode: 0o600 });
  await writeFile(
    join(source, "fixture-command.mjs"),
    "await new Promise((resolve) => setTimeout(resolve, 250)); process.stdout.write('fixture complete\\n');\n",
    { mode: 0o700 }
  );
  await run("/usr/bin/git", ["add", "tracked.txt", "fixture-command.mjs"], source);
  await run("/usr/bin/git", ["commit", "-m", "fixture"], source);

  const hookSentinel = join(sentinelsRoot, "hook.invoked");
  const filterSentinel = join(sentinelsRoot, "filter.invoked");
  const fsmonitorSentinel = join(sentinelsRoot, "fsmonitor.invoked");
  await writeFile(
    join(source, ".git", "hooks", "post-checkout"),
    `#!/bin/sh\n: > '${hookSentinel}'\n`,
    { mode: 0o700 }
  );
  await writeFile(join(sentinelsRoot, "filter-probe"), `#!/bin/sh\n: > '${filterSentinel}'\n`, {
    mode: 0o700
  });
  await writeFile(
    join(sentinelsRoot, "fsmonitor-probe"),
    `#!/bin/sh\n: > '${fsmonitorSentinel}'\n`,
    { mode: 0o700 }
  );
  await writeFile(join(source, "tracked.txt"), "user-dirty\n", { mode: 0o600 });
  await writeFile(join(source, "user-untracked.txt"), "keep this user file\n", { mode: 0o600 });

  const canonicalSource = await realpath(source);
  const token = createHash("sha256").update(randomUUID()).digest("base64url").slice(0, 43);
  const descriptor = join(root, "verifier", "launch.json");
  await mkdir(join(root, "verifier"), { mode: 0o700 });
  const writeDescriptor = async (): Promise<string> => {
    await writeFile(
      descriptor,
      `${JSON.stringify({
        schemaVersion: 1,
        userDataRoot: await realpath(userData),
        repositoryPath: canonicalSource,
        apiToken: token
      })}\n`,
      { mode: 0o600 }
    );
    await chmod(descriptor, 0o600);
    return descriptor;
  };
  await writeDescriptor();
  const metadata = await stat(descriptor);
  if ((metadata.mode & 0o777) !== 0o600) throw new TypeError("unsafe verifier descriptor");
  const initial = await captureInvariant(canonicalSource);

  return {
    root,
    source: canonicalSource,
    userData: await realpath(userData),
    evidence: await realpath(evidence),
    descriptor,
    sentinels: [hookSentinel, filterSentinel, fsmonitorSentinel],
    token,
    initial,
    writeDescriptor,
    capture: async () => await captureInvariant(canonicalSource),
    cleanup: async () => await rm(root, { recursive: true, force: true })
  };
};

export const assertScenarioUnchanged = async (scenario: TestRepositoryScenario): Promise<void> => {
  const current = await scenario.capture();
  if (JSON.stringify(current) !== JSON.stringify(scenario.initial)) {
    throw new Error(`source checkout changed: ${basename(scenario.source)}`);
  }
  for (const marker of scenario.sentinels) {
    try {
      await stat(marker);
      throw new Error(`repository helper executed: ${basename(marker)}`);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
};
