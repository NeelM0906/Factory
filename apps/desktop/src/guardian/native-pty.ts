import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";

import type {
  AtomicPtySpawnAuthority,
  BoundProcessTreeAuthority,
  ProcessTreeExitProof,
  PtyExit,
  PtySpawnRequest
} from "@autostack/runner-local";

interface Disposable {
  dispose(): void;
}

interface NativePty {
  readonly pid: number;
  write(value: string): void;
  resize(columns: number, rows: number): void;
  onData(listener: (value: string) => void): Disposable;
  onExit(
    listener: (value: { readonly exitCode: number; readonly signal?: number }) => void
  ): Disposable;
}

export interface NodePtyModule {
  spawn(
    executable: string,
    args: string[],
    options: {
      readonly cwd: string;
      readonly env: Record<string, string>;
      readonly cols: number;
      readonly rows: number;
      readonly encoding: null;
    }
  ): NativePty;
}

export interface NativePtyPlatform {
  signalGroup(processGroupId: number, signal: "SIGINT" | "SIGTERM" | "SIGKILL"): void;
  processGroupExists?(processGroupId: number): boolean;
}

const pathIdentityDigest = (path: string, kind: "file" | "directory"): string => {
  const canonical = realpathSync(path);
  if (canonical !== path) throw new TypeError("path is not canonical");
  const metadata = lstatSync(path);
  if (
    metadata.isSymbolicLink() ||
    (kind === "file" ? !metadata.isFile() : !metadata.isDirectory())
  ) {
    throw new TypeError("path identity is invalid");
  }
  return createHash("sha256")
    .update(`${canonical}\0${metadata.dev.toString()}\0${metadata.ino.toString()}`)
    .digest("hex");
};

const assertPrivateDirectory = (path: string): void => {
  pathIdentityDigest(path, "directory");
  const metadata = lstatSync(path);
  if (metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) {
    throw new TypeError("private command directory is unsafe");
  }
};

const signalName = (signal: number | undefined): string | null => {
  if (signal === undefined || signal === 0) return null;
  return (
    ({ 1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 9: "SIGKILL", 15: "SIGTERM" } as const)[
      signal as 1
    ] ?? `SIGNAL_${signal}`
  );
};

const abortError = (): DOMException => new DOMException("The operation was aborted.", "AbortError");

export const createNodePtySpawnAuthority = (
  nodePty: NodePtyModule,
  platform: NativePtyPlatform = {
    signalGroup: (processGroupId, signal) => process.kill(-processGroupId, signal),
    processGroupExists: (processGroupId) => {
      try {
        process.kill(-processGroupId, 0);
        return true;
      } catch (error) {
        return !(error instanceof Error && "code" in error && error.code === "ESRCH");
      }
    }
  }
): AtomicPtySpawnAuthority => ({
  spawnBound(input) {
    const request: PtySpawnRequest = input.request;
    try {
      if (
        pathIdentityDigest(request.executable, "file") !== input.expectedExecutableIdentityDigest ||
        pathIdentityDigest(request.cwd, "directory") !== input.expectedCwdIdentityDigest
      ) {
        return { status: "rejected" };
      }
      assertPrivateDirectory(input.privateEnvironment.home);
      assertPrivateDirectory(input.privateEnvironment.temporary);
      const environment: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const entry of request.environment) {
        if (Object.hasOwn(environment, entry.name)) return { status: "rejected" };
        environment[entry.name] = entry.value;
      }
      if (
        environment.HOME !== input.privateEnvironment.home ||
        environment.TMPDIR !== input.privateEnvironment.temporary
      ) {
        return { status: "rejected" };
      }
      const pty = nodePty.spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: environment,
        cols: request.terminal.columns,
        rows: request.terminal.rows,
        encoding: null
      });
      const identityDigest = createHash("sha256")
        .update(`${pty.pid}\0${randomUUID()}`)
        .digest("hex");
      let exit: PtyExit | undefined;
      let resolveExit!: (value: PtyExit) => void;
      const exited = new Promise<PtyExit>((resolve) => {
        resolveExit = resolve;
      });
      let liveness: ReturnType<typeof setInterval> | undefined;
      const settleExit = (value: PtyExit): void => {
        if (exit !== undefined) return;
        exit = Object.freeze(value);
        if (liveness !== undefined) clearInterval(liveness);
        input.capture.onEof();
        input.capture.onExit(exit);
        resolveExit(exit);
      };
      const data = pty.onData((value) => input.capture.onData(Buffer.from(value, "latin1")));
      const closed = pty.onExit((value) => {
        settleExit({ exitCode: value.exitCode, signal: signalName(value.signal) });
      });
      if (platform.processGroupExists !== undefined) {
        liveness = setInterval(() => {
          if (exit !== undefined || platform.processGroupExists?.(pty.pid) !== false) return;
          settleExit({ exitCode: null, signal: "PROCESS_EXIT_UNOBSERVED" });
        }, 25);
        liveness.unref();
      }
      const processTree: BoundProcessTreeAuthority = Object.freeze({
        identityDigest,
        async signal(signal: "SIGINT" | "SIGTERM" | "SIGKILL", abortSignal: AbortSignal) {
          if (abortSignal.aborted) throw abortError();
          if (exit !== undefined) return;
          platform.signalGroup(pty.pid, signal);
        },
        async waitForExit(abortSignal: AbortSignal): Promise<ProcessTreeExitProof> {
          if (abortSignal.aborted) throw abortError();
          const observed = await Promise.race([
            exited,
            new Promise<never>((_resolve, reject) =>
              abortSignal.addEventListener("abort", () => reject(abortError()), { once: true })
            )
          ]);
          return Object.freeze({ identityDigest, processTreeTerminated: true, exit: observed });
        }
      });
      return Object.freeze({
        status: "spawned" as const,
        session: Object.freeze({
          write: (value: string) => pty.write(value),
          resize: (columns: number, rows: number) => pty.resize(columns, rows)
        }),
        processTree,
        capture: Object.freeze({
          dispose: () => {
            if (liveness !== undefined) clearInterval(liveness);
            data.dispose();
            closed.dispose();
          }
        })
      });
    } catch {
      return { status: "rejected" };
    }
  }
});
