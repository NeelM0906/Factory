import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodePtySpawnAuthority, type NodePtyModule } from "../../src/guardian/native-pty.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "autostack-quick-exit-")));
try {
  await chmod(root, 0o700);
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  const cwd = join(root, "cwd");
  await Promise.all(
    [home, temporary, cwd].map(async (path) => {
      await mkdir(path, { mode: 0o700 });
      await chmod(path, 0o700);
    })
  );
  const identity = async (path: string): Promise<string> => {
    const canonical = await realpath(path);
    const metadata = await stat(canonical);
    return createHash("sha256")
      .update(`${canonical}\0${metadata.dev.toString()}\0${metadata.ino.toString()}`)
      .digest("hex");
  };
  const nativeRequire = createRequire(join(import.meta.dirname, "../dist/runtime/native/package.json"));
  const authority = createNodePtySpawnAuthority(nativeRequire("node-pty") as NodePtyModule);
  let resolveTerminal!: (value: { readonly exitCode: number | null; readonly signal: string | null }) => void;
  const terminal = new Promise<{
    readonly exitCode: number | null;
    readonly signal: string | null;
  }>((resolve) => {
    resolveTerminal = resolve;
  });
  const executable = await realpath("/usr/bin/printf");
  const spawned = authority.spawnBound({
    request: {
      executable,
      args: [""],
      cwd,
      environment: [
        { name: "HOME", value: home },
        { name: "TMPDIR", value: temporary },
        { name: "PATH", value: "/usr/bin:/bin" }
      ],
      terminal: { columns: 80, rows: 24 }
    },
    expectedExecutableIdentityDigest: await identity(executable),
    expectedCwdIdentityDigest: await identity(cwd),
    privateEnvironment: { home, temporary },
    capture: { onData() {}, onEof() {}, onExit: resolveTerminal }
  });
  if (spawned.status !== "spawned") throw new TypeError("quick-exit spawn was rejected");
  const outcome = await Promise.race([
    terminal,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new TypeError("quick-exit terminal proof timed out")), 2_000)
    )
  ]);
  if (outcome.exitCode !== 0 && outcome.signal !== "PROCESS_EXIT_UNOBSERVED") {
    throw new TypeError("quick-exit produced an inadmissible terminal outcome");
  }
  process.stdout.write(
    `${JSON.stringify({ status: "passed", outcome: outcome.exitCode === 0 ? "observed" : "fail_closed" })}\n`
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
