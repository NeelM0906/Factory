import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

export type ProcessRunErrorCode =
  "invalid_request" | "launch_failed" | "timed_out" | "output_limit" | "termination_failed";

const PROCESS_ERROR_MESSAGES = Object.freeze({
  invalid_request: "The process request is invalid.",
  launch_failed: "The process could not be launched.",
  timed_out: "The process exceeded its duration limit.",
  output_limit: "The process exceeded its output limit.",
  termination_failed: "The process tree could not be proven terminated."
} satisfies Readonly<Record<ProcessRunErrorCode, string>>);

const internalProcessErrorCodes = new WeakMap<object, ProcessRunErrorCode>();
const trustedPublicProcessErrorCodes = new WeakMap<object, ProcessRunErrorCode>();

export class ProcessRunError extends Error {
  readonly code: ProcessRunErrorCode;

  constructor(code: ProcessRunErrorCode, _untrustedMessage?: string) {
    const admittedCode = Object.hasOwn(PROCESS_ERROR_MESSAGES, code) ? code : "invalid_request";
    super(PROCESS_ERROR_MESSAGES[admittedCode]);
    this.name = "ProcessRunError";
    this.code = admittedCode;
    Object.freeze(this);
  }
}

class InternalProcessRunError extends Error {
  readonly code: ProcessRunErrorCode;

  constructor(code: ProcessRunErrorCode) {
    super(PROCESS_ERROR_MESSAGES[code]);
    this.code = code;
    internalProcessErrorCodes.set(this, code);
    Object.freeze(this);
  }
}

const processError = (code: ProcessRunErrorCode): InternalProcessRunError =>
  new InternalProcessRunError(code);
const internalProcessErrorCode = (error: unknown): ProcessRunErrorCode | undefined =>
  (typeof error === "object" && error !== null) || typeof error === "function"
    ? internalProcessErrorCodes.get(error)
    : undefined;
const isInternalProcessError = (error: unknown): error is InternalProcessRunError =>
  internalProcessErrorCode(error) !== undefined;
const materializeProcessError = (
  error: unknown,
  fallback: ProcessRunErrorCode
): ProcessRunError => {
  const code = internalProcessErrorCode(error) ?? fallback;
  const materialized = new ProcessRunError(code);
  trustedPublicProcessErrorCodes.set(materialized, code);
  return materialized;
};

/** Package-internal immutable provenance for trusted runner composition. */
export const trustedProcessRunErrorCode = (error: unknown): ProcessRunErrorCode | undefined =>
  (typeof error === "object" && error !== null) || typeof error === "function"
    ? trustedPublicProcessErrorCodes.get(error)
    : undefined;

export interface ProcessEnvironmentEntry {
  readonly name: string;
  readonly value: string;
}

export interface ProcessRunRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: readonly ProcessEnvironmentEntry[];
}

export interface ProcessRunResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessRunner {
  run(request: ProcessRunRequest): Promise<ProcessRunResult>;
}

export interface BoundedProcessRunnerOptions {
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
}

interface AdmittedProcessRunRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

const snapshotString = (value: unknown, maximumLength: number, allowEmpty = true): string => {
  if (
    typeof value !== "string" ||
    value.length > maximumLength ||
    (!allowEmpty && value.length === 0) ||
    value.includes("\0")
  ) {
    throw processError("invalid_request");
  }
  return value;
};

const snapshotStringArray = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) {
    throw processError("invalid_request");
  }
  const length: unknown = value.length;
  if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > 256) {
    throw processError("invalid_request");
  }
  const output: string[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    output.push(snapshotString(value[index], 8_192));
  }
  return Object.freeze(output);
};

const snapshotEnvironment = (value: unknown): Readonly<Record<string, string>> => {
  if (!Array.isArray(value)) {
    throw processError("invalid_request");
  }
  const length: unknown = value.length;
  if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > 128) {
    throw processError("invalid_request");
  }
  const environment = Object.create(null) as Record<string, string>;
  let totalBytes = 0;
  for (let index = 0; index < (length as number); index += 1) {
    const entry: unknown = value[index];
    if (typeof entry !== "object" || entry === null) {
      throw processError("invalid_request");
    }
    let name: string;
    let entryValue: string;
    try {
      const candidate = entry as { readonly name?: unknown; readonly value?: unknown };
      name = snapshotString(candidate.name, 128, false);
      entryValue = snapshotString(candidate.value, 8_192);
    } catch {
      throw processError("invalid_request");
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || Object.hasOwn(environment, name)) {
      throw processError("invalid_request");
    }
    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(entryValue);
    if (totalBytes > 512 * 1024) throw processError("invalid_request");
    environment[name] = entryValue;
  }
  return Object.freeze(environment);
};

const admitRequest = (request: ProcessRunRequest): AdmittedProcessRunRequest => {
  try {
    if (typeof request !== "object" || request === null) {
      throw processError("invalid_request");
    }
    const executable = snapshotString(request.executable, 8_192, false);
    const cwd = snapshotString(request.cwd, 8_192, false);
    if (!isAbsolute(executable) || !isAbsolute(cwd)) {
      throw processError("invalid_request");
    }
    return Object.freeze({
      executable,
      args: snapshotStringArray(request.args),
      cwd,
      environment: snapshotEnvironment(request.environment)
    });
  } catch (error) {
    if (isInternalProcessError(error)) throw error;
    throw processError("invalid_request");
  }
};

const positiveBoundedInteger = (value: unknown, maximum: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw processError("invalid_request");
  }
  return value as number;
};

/**
 * A bounded executable-plus-arguments process boundary. There is deliberately
 * no shell option and the child receives only the supplied environment.
 */
export class BoundedProcessRunner implements ProcessRunner {
  readonly #timeoutMs: number;
  readonly #maximumOutputBytes: number;

  constructor(options: BoundedProcessRunnerOptions) {
    try {
      const timeoutMs = options.timeoutMs;
      const maximumOutputBytes = options.maximumOutputBytes;
      this.#timeoutMs = positiveBoundedInteger(timeoutMs, 120_000);
      this.#maximumOutputBytes = positiveBoundedInteger(maximumOutputBytes, 16 * 1024 * 1024);
    } catch (error) {
      throw materializeProcessError(error, "invalid_request");
    }
  }

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    try {
      return await this.#run(request);
    } catch (error) {
      throw materializeProcessError(error, "launch_failed");
    }
  }

  async #run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    const admitted = admitRequest(request);
    return await new Promise<ProcessRunResult>((resolve, reject) => {
      let child;
      try {
        const isolatedProcessGroup = process.platform !== "win32";
        child = spawn(admitted.executable, admitted.args, {
          cwd: admitted.cwd,
          env: admitted.environment,
          detached: isolatedProcessGroup,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        });
      } catch {
        reject(processError("launch_failed"));
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let promiseSettled = false;
      let closed = false;
      let terminating: InternalProcessRunError | undefined;
      let timer: NodeJS.Timeout | undefined;
      let cleanupTimer: NodeJS.Timeout | undefined;
      let supervisionTimer: NodeJS.Timeout | undefined;
      const isolatedProcessGroup = process.platform !== "win32";

      const signalProcessTree = (): void => {
        const processGroupId = child.pid;
        let groupKilled = false;
        if (
          isolatedProcessGroup &&
          Number.isSafeInteger(processGroupId) &&
          (processGroupId as number) > 0
        ) {
          try {
            process.kill(-(processGroupId as number), "SIGKILL");
            groupKilled = true;
          } catch {
            // Fall through to the exact direct child only.
          }
        }
        if (!groupKilled) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The close event or cleanup grace determines settlement.
          }
        }
      };

      const terminate = (error: InternalProcessRunError): void => {
        if (closed || terminating !== undefined) return;
        terminating = error;
        if (timer !== undefined) clearTimeout(timer);
        signalProcessTree();
        if (closed) return;
        cleanupTimer = setTimeout(() => {
          if (closed) return;
          signalProcessTree();
          if (!promiseSettled) {
            promiseSettled = true;
            reject(processError("termination_failed"));
          }
          supervisionTimer = setInterval(() => {
            if (!closed) signalProcessTree();
          }, 250);
        }, 1_000);
        cleanupTimer.unref();
      };

      const capture = (target: Buffer[], chunk: Buffer): void => {
        if (promiseSettled || terminating !== undefined) return;
        outputBytes += chunk.byteLength;
        if (outputBytes > this.#maximumOutputBytes) {
          terminate(processError("output_limit"));
          return;
        }
        target.push(Buffer.from(chunk));
      };

      child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));

      timer = setTimeout(() => {
        terminate(processError("timed_out"));
      }, this.#timeoutMs);
      timer.unref();

      child.once("error", () => {
        if (closed || promiseSettled || terminating !== undefined) return;
        promiseSettled = true;
        if (timer !== undefined) clearTimeout(timer);
        reject(processError("launch_failed"));
      });
      child.once("close", (exitCode, signal) => {
        if (closed) return;
        closed = true;
        if (timer !== undefined) clearTimeout(timer);
        if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
        if (supervisionTimer !== undefined) clearInterval(supervisionTimer);
        if (promiseSettled) return;
        promiseSettled = true;
        if (terminating !== undefined) {
          reject(terminating);
          return;
        }
        resolve(
          Object.freeze({
            exitCode,
            signal,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8")
          })
        );
      });
    });
  }
}
