import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { EventEmitter } from "node:events";

import { createIdFactory } from "@autostack/contracts";
import {
  createProductionHostRunnerFactory,
  listenOnLoopback,
  runForkableHostUtilityProcess,
  validateGuardianRuntime,
  type HostParentPort
} from "../../../host-daemon/src/index.js";
import { CommandGuardianHostProtocolAdapter } from "@autostack/runner-local/guardian-child";
import { ReplaySpool } from "@autostack/runner-local/host-runtime";
import type {
  ExecutableResolver,
  GuardianAuthenticatedEnvelope,
  GuardianBootstrap,
  GuardianHostObserver,
  GuardianLauncher
} from "@autostack/runner-local";
import { DurableTerminalEvidenceAuthority } from "./terminal-evidence-authority.js";

const parentPort = process.parentPort;
if (parentPort === undefined || parentPort === null) {
  throw new TypeError("host utility parent port is unavailable");
}

const PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

class ElectronHostParentPort extends EventEmitter implements HostParentPort {
  constructor(evidence: DurableTerminalEvidenceAuthority) {
    super();
    parentPort.on("message", (event) => {
      const candidate = event.data;
      if (
        candidate !== null &&
        typeof candidate === "object" &&
        (candidate as { schemaVersion?: unknown }).schemaVersion === 1 &&
        (candidate as { type?: unknown }).type === "terminal-evidence.authorize" &&
        typeof (candidate as { requestId?: unknown }).requestId === "string"
      ) {
        try {
          evidence.authorize((candidate as { request?: unknown }).request);
          parentPort.postMessage({
            schemaVersion: 1,
            type: "terminal-evidence.authorized",
            requestId: (candidate as { requestId: string }).requestId,
            ok: true
          });
        } catch {
          parentPort.postMessage({
            schemaVersion: 1,
            type: "terminal-evidence.authorized",
            requestId: (candidate as { requestId: string }).requestId,
            ok: false
          });
        }
        return;
      }
      this.emit("message", candidate);
    });
  }

  postMessage(message: unknown): void {
    parentPort.postMessage(message);
  }
}

const sendChild = async (child: ChildProcess, message: unknown): Promise<void> =>
  await new Promise((resolve, reject) => {
    if (!child.connected) {
      reject(new TypeError("guardian transport is unavailable"));
      return;
    }
    child.send(message as never, (error) => (error === null ? resolve() : reject(error)));
  });

const createGuardianLauncher = (
  electronExecutable: string,
  guardianModule: string,
  desktopBuildRoot: string
): GuardianLauncher => ({
  async launch(bootstrap: GuardianBootstrap, observer: GuardianHostObserver) {
    const spool = await ReplaySpool.open({
      dataRoot: bootstrap.dataRoot,
      commandId: bootstrap.commandId
    });
    const child = fork(guardianModule, [], {
      execPath: electronExecutable,
      cwd: desktopBuildRoot,
      env: { ELECTRON_RUN_AS_NODE: "1" },
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    let adapter!: CommandGuardianHostProtocolAdapter;
    adapter = CommandGuardianHostProtocolAdapter.create({
      bootstrap,
      observer,
      send: async (message, signal) => {
        if (signal.aborted) throw new TypeError("guardian send was aborted");
        await sendChild(child, message);
      },
      disconnect: async () => {
        child.disconnect();
      }
    });
    let admittedBootstrapMessages = 0;
    child.on("message", (message: GuardianAuthenticatedEnvelope<unknown>) => {
      void (async () => {
        await adapter.receive(message as never);
        admittedBootstrapMessages += 1;
        if (admittedBootstrapMessages === 2) {
          await adapter.transferLease(spool.intent.receiptDigest);
        }
      })().catch(() => adapter.transportClosed());
    });
    child.once("exit", () => void adapter.transportClosed());
    child.once("disconnect", () => void adapter.transportClosed());
    await sendChild(child, { schemaVersion: 1, type: "guardian.bootstrap", bootstrap });
    return adapter.session;
  }
});

interface ExecutableIdentity {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly digest: string;
}

const inspectExecutable = async (path: string): Promise<ExecutableIdentity> => {
  const canonical = await realpath(path);
  const link = await lstat(path);
  const metadata = await stat(canonical, { bigint: true });
  const uid = BigInt(process.getuid?.() ?? -1);
  if (
    link.isSymbolicLink() ||
    !metadata.isFile() ||
    (metadata.uid !== uid && metadata.uid !== 0n) ||
    (Number(metadata.mode) & 0o111) === 0
  ) {
    throw new TypeError("executable identity is unsafe");
  }
  await access(canonical, constants.X_OK);
  return {
    path: canonical,
    device: metadata.dev,
    inode: metadata.ino,
    digest: createHash("sha256")
      .update(canonical)
      .update("\0")
      .update(metadata.dev.toString())
      .update("\0")
      .update(metadata.ino.toString())
      .digest("hex")
  };
};

const resolveExecutablePath = async (executable: string): Promise<string> => {
  if (isAbsolute(executable)) return executable;
  if (executable.length === 0 || executable.includes("/")) {
    throw new TypeError("invalid executable");
  }
  for (const directory of PATH.split(":")) {
    const candidate = join(directory, executable);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the fixed trusted search path.
    }
  }
  throw new TypeError("executable is unavailable");
};

const executableResolver: ExecutableResolver = {
  async resolve({ executable }) {
    const pinned = await inspectExecutable(await resolveExecutablePath(executable));
    return {
      canonicalPath: pinned.path,
      identityDigest: pinned.digest,
      async revalidate() {
        try {
          const current = await inspectExecutable(pinned.path);
          return (
            current.path === pinned.path &&
            current.device === pinned.device &&
            current.inode === pinned.inode &&
            current.digest === pinned.digest
          );
        } catch {
          return false;
        }
      }
    };
  }
};

const terminalEvidence = new DurableTerminalEvidenceAuthority();
const parent = new ElectronHostParentPort(terminalEvidence);
const ids = createIdFactory();
const keepAlive = setInterval(() => undefined, 60_000);

/**
 * The only channel this process has for saying why it died. `runForkableHostUtilityProcess` fails
 * closed by setting a nonzero exit code and dropping the error, so before this the host exited 1 in
 * total silence -- CI runs 33113576845 and 33116320549 both produced a bare
 * `[autostack-e2e-utility-exit] host:1` and nothing else. Shaped like the control plane's own
 * startup report (apps/control-plane/src/server.ts:327-336).
 */
const describeError = (
  error: unknown
): { readonly message: string; readonly code: string | null; readonly stack: string | null } => {
  if (!(error instanceof Error)) {
    return { message: "Unknown startup error.", code: null, stack: null };
  }
  const code: unknown = Reflect.get(error, "code");
  return {
    message: `${error.name}: ${error.message}`,
    code: typeof code === "string" ? code : null,
    stack: error.stack ?? null
  };
};

const reportStartupFailure = (error: unknown): void => {
  // Walks the whole cause chain. The boundary errors are stable by design -- "The local runner
  // failed closed." says nothing on its own -- so the layer that actually failed is reachable only
  // through the causes those errors now retain. Bounded at eight links, and cycle-guarded, so a
  // pathological chain cannot turn a diagnostic into a hang.
  const chain: ReturnType<typeof describeError>[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && chain.length < 8 && !seen.has(current)) {
    seen.add(current);
    chain.push(describeError(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  console.error(
    JSON.stringify({
      level: "error",
      event: "host_start_failed",
      message: chain[0]?.message ?? "Unknown startup error.",
      code: chain[0]?.code ?? null,
      causes: chain.slice(1),
      stack: chain[0]?.stack ?? null
    })
  );
};

try {
  await runForkableHostUtilityProcess({
    parent,
    environment: process.env,
    pid: process.pid,
    validateRuntime: validateGuardianRuntime,
    listen: listenOnLoopback,
    requestId: randomUUID,
    log: () => undefined,
    onStartupFailure: reportStartupFailure,
    signals: false,
    createRunner: async ({ dataRoot, runtime }) =>
      await createProductionHostRunnerFactory({
        createGuardianLauncher: async () =>
          createGuardianLauncher(
            runtime.descriptor.electronExecutable,
            runtime.descriptor.guardianModule,
            runtime.descriptor.desktopBuildRoot
          ),
        localRunnerOptions: {
          resolveCredentials: async () => [],
          executableResolver,
          trustedBaseEnvironment: [
            { name: "PATH", value: PATH },
            { name: "HOME", value: join(dataRoot, "runtime", "home") },
            { name: "TMPDIR", value: join(dataRoot, "runtime", "tmp") },
            { name: "LANG", value: "C" },
            { name: "LC_ALL", value: "C" },
            { name: "TERM", value: "xterm-256color" }
          ],
          limits: {
            eventBytes: 65_536,
            replayBytes: 1_048_576,
            transcriptBytes: 16_777_216,
            artifactBytes: 16_777_216,
            cancellationGraceMs: 5_000,
            eofSettleMs: 250,
            subscriberQueueFrames: 256,
            subscriberQueueBytes: 4_194_304
          },
          now: () => new Date().toISOString(),
          monotonicNowMs: () => performance.now(),
          createArtifactId: ids.artifact,
          createGuardianSession: () => ({
            sessionId: randomUUID(),
            secret: randomBytes(32),
            bindingDigest: "0".repeat(64)
          }),
          verifyTerminalEvidence: async (verification) => terminalEvidence.verify(verification),
          trustedGitExecutable: "/usr/bin/git"
        }
      })({ dataRoot, runtime })
  });
} catch (error: unknown) {
  // Second layer. This catches a throw that escapes the daemon entirely; the reporter passed as
  // `onStartupFailure` above catches the far more common case, where the daemon converts a startup
  // error into a nonzero exit code and discards the error itself.
  reportStartupFailure(error);
  process.exitCode = 1;
} finally {
  clearInterval(keepAlive);
}
process.exit(process.exitCode ?? 0);
