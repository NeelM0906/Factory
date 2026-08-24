import { randomBytes } from "node:crypto";

import type { DesktopRuntimeStatus, GuardianLaunchDescriptor } from "@autostack/contracts";

type Service = "host" | "control-plane";
type Lifecycle = "quiesce" | "interrupt-and-drain" | "close" | "retire-generation";

export interface RuntimeChild {
  readonly pid: number;
  postMessage(message: unknown): void;
  waitReady(): Promise<{ readonly service: string; readonly pid: number; readonly origin: string }>;
  sendLifecycle(type: Lifecycle): Promise<unknown>;
  requestDesktop?(request: unknown): Promise<unknown>;
  authorizeTerminalEvidence?(request: unknown): Promise<void>;
  close(): Promise<void>;
  onExit?(listener: () => void): () => void;
}

export interface RuntimeSupervisorOptions {
  readonly launch: (service: Service, environment: NodeJS.ProcessEnv) => Promise<RuntimeChild>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly createHostToken?: () => string;
  readonly onStatus?: (status: DesktopRuntimeStatus) => void;
  readonly restartLimit?: number;
  readonly restartDelayMs?: number;
  readonly lifecycleTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface RuntimeStartOptions {
  readonly instanceId: string;
  readonly hostToken?: string;
  readonly apiTokenDigest: string;
  readonly hostDataRoot: string;
  readonly controlPlaneDataDirectory: string;
  readonly guardian: GuardianLaunchDescriptor;
}

const ALLOWED_ENVIRONMENT = ["LANG", "LC_ALL", "PATH", "TZ"] as const;
const DEFAULT_LIFECYCLE_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;

const withTimeout = async <T>(operation: Promise<T>, milliseconds: number): Promise<T> =>
  await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("runtime lifecycle operation timed out")),
      milliseconds
    );
    timer.unref();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

export const sanitizeUtilityEnvironment = (
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv =>
  Object.fromEntries(
    ALLOWED_ENVIRONMENT.flatMap((name) => {
      const value = source[name];
      return value === undefined ? [] : [[name, value]];
    })
  );

const validateReady = (
  service: Service,
  child: RuntimeChild,
  value: Awaited<ReturnType<RuntimeChild["waitReady"]>>
): string => {
  const expected = service === "host" ? "autostack-host-daemon" : "autostack-control-plane";
  if (value.service !== expected || value.pid !== child.pid)
    throw new TypeError("invalid readiness");
  const url = new URL(value.origin);
  const port = Number(url.port);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("invalid readiness origin");
  }
  return url.origin;
};

export class RuntimeSupervisor {
  readonly #options: RuntimeSupervisorOptions;
  #status: DesktopRuntimeStatus = { status: "stopped" };
  #host: RuntimeChild | undefined;
  #controlPlane: RuntimeChild | undefined;
  #hostOrigin: string | undefined;
  #controlPlaneOrigin: string | undefined;
  #hostToken: string | undefined;
  #startOptions: RuntimeStartOptions | undefined;
  #stopping = false;
  #recovering: Promise<void> | undefined;
  #pendingRecovery: Service | undefined;
  #restartCount = 0;
  #removeHostExit = (): void => undefined;
  #removeControlPlaneExit = (): void => undefined;

  constructor(options: RuntimeSupervisorOptions) {
    this.#options = options;
  }

  status(): DesktopRuntimeStatus {
    return { ...this.#status };
  }

  controlPlaneOrigin(): string | undefined {
    return this.#controlPlaneOrigin;
  }

  async dispatchLocal(request: unknown): Promise<unknown> {
    if (
      this.#stopping ||
      this.#status.status !== "ready" ||
      this.#controlPlane?.requestDesktop === undefined
    ) {
      throw new Error("Desktop local-operation dispatcher unavailable.");
    }
    return await this.#controlPlane.requestDesktop(request);
  }

  async authorizeTerminalEvidence(request: unknown): Promise<void> {
    if (this.#status.status !== "ready" || this.#host?.authorizeTerminalEvidence === undefined) {
      throw new Error("Host terminal evidence authority unavailable.");
    }
    await this.#host.authorizeTerminalEvidence(request);
  }

  #setStatus(status: DesktopRuntimeStatus): void {
    this.#status = status;
    this.#options.onStatus?.({ ...status });
  }

  #createHostToken(): string {
    return this.#options.createHostToken?.() ?? randomBytes(32).toString("base64url");
  }

  #watch(service: Service, child: RuntimeChild): void {
    const remove = child.onExit?.(() => {
      if (this.#stopping) return;
      if (service === "host" && this.#host !== child) return;
      if (service === "control-plane" && this.#controlPlane !== child) return;
      this.#scheduleRecovery(service);
    });
    if (service === "host") this.#removeHostExit = remove ?? (() => undefined);
    else this.#removeControlPlaneExit = remove ?? (() => undefined);
  }

  async #launchHost(environment: NodeJS.ProcessEnv): Promise<void> {
    const options = this.#startOptions;
    if (options === undefined) throw new TypeError("runtime is not configured");
    const token = this.#hostToken ?? this.#createHostToken();
    this.#hostToken = token;
    const host = await this.#options.launch("host", environment);
    this.#host = host;
    this.#watch("host", host);
    host.postMessage({
      schemaVersion: 1,
      type: "host.bootstrap",
      hostToken: token,
      dataRoot: options.hostDataRoot,
      host: "127.0.0.1",
      port: 0,
      guardian: options.guardian
    });
    this.#hostOrigin = validateReady("host", host, await host.waitReady());
  }

  async #launchControlPlane(environment: NodeJS.ProcessEnv): Promise<void> {
    const options = this.#startOptions;
    if (options === undefined || this.#hostOrigin === undefined || this.#hostToken === undefined) {
      throw new TypeError("host generation is not ready");
    }
    const controlPlane = await this.#options.launch("control-plane", environment);
    this.#controlPlane = controlPlane;
    this.#watch("control-plane", controlPlane);
    controlPlane.postMessage({
      schemaVersion: 1,
      type: "control-plane.bootstrap",
      instanceId: options.instanceId,
      apiTokenDigest: options.apiTokenDigest,
      dataDirectory: options.controlPlaneDataDirectory,
      hostOrigin: this.#hostOrigin,
      hostToken: this.#hostToken,
      host: "127.0.0.1",
      port: 0
    });
    this.#controlPlaneOrigin = validateReady(
      "control-plane",
      controlPlane,
      await controlPlane.waitReady()
    );
  }

  async start(options: RuntimeStartOptions): Promise<void> {
    if (this.#status.status !== "stopped") throw new TypeError("runtime is already active");
    this.#startOptions = options;
    this.#hostToken = options.hostToken ?? this.#createHostToken();
    this.#restartCount = 0;
    this.#setStatus({ status: "starting" });
    const environment = sanitizeUtilityEnvironment(this.#options.environment);
    try {
      await this.#launchHost(environment);
      await this.#launchControlPlane(environment);
      this.#setStatus({ status: "ready" });
    } catch (error: unknown) {
      this.#setStatus({ status: "degraded", message: "Local runtime failed to start." });
      throw new Error("local runtime failed to start", { cause: error });
    }
  }

  #scheduleRecovery(service: Service): void {
    this.#pendingRecovery =
      service === "host" || this.#pendingRecovery === "host" ? "host" : "control-plane";
    if (this.#recovering !== undefined) return;
    this.#recovering = this.#drainRecoveries().finally(() => {
      this.#recovering = undefined;
      if (this.#pendingRecovery !== undefined && !this.#stopping) {
        this.#scheduleRecovery(this.#pendingRecovery);
      }
    });
  }

  async #drainRecoveries(): Promise<void> {
    while (this.#pendingRecovery !== undefined && !this.#stopping) {
      const service = this.#pendingRecovery;
      this.#pendingRecovery = undefined;
      if (!(await this.#recover(service))) return;
    }
  }

  async #closeAttempt(includeHost: boolean): Promise<void> {
    const host = includeHost ? this.#host : undefined;
    const controlPlane = this.#controlPlane;
    if (includeHost) {
      this.#removeHostExit();
      this.#host = undefined;
      this.#hostOrigin = undefined;
    }
    this.#removeControlPlaneExit();
    this.#controlPlane = undefined;
    this.#controlPlaneOrigin = undefined;
    await controlPlane?.close().catch(() => undefined);
    await host?.close().catch(() => undefined);
  }

  async #recover(service: Service): Promise<boolean> {
    const limit = this.#options.restartLimit ?? 8;
    const delay = this.#options.restartDelayMs ?? 50;
    const sleep =
      this.#options.sleep ??
      (async (milliseconds: number) =>
        await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    this.#setStatus({ status: "degraded", message: "Local runtime is restarting." });
    const environment = sanitizeUtilityEnvironment(this.#options.environment);

    if (service === "host") {
      const oldControlPlane = this.#controlPlane;
      this.#removeHostExit();
      this.#removeControlPlaneExit();
      this.#host = undefined;
      this.#controlPlane = undefined;
      this.#hostOrigin = undefined;
      this.#controlPlaneOrigin = undefined;
      if (oldControlPlane !== undefined) {
        await oldControlPlane.sendLifecycle("retire-generation").catch(() => undefined);
        await oldControlPlane.close().catch(() => undefined);
      }
    } else {
      await this.#closeAttempt(false);
    }

    while (!this.#stopping && this.#restartCount < limit) {
      this.#restartCount += 1;
      let hostReady = service === "control-plane";
      try {
        if (service === "host") {
          this.#hostToken = this.#createHostToken();
          await this.#launchHost(environment);
          hostReady = true;
        }
        await this.#launchControlPlane(environment);
        if (this.#pendingRecovery === "host") {
          this.#pendingRecovery = undefined;
          await this.#closeAttempt(true);
          service = "host";
          hostReady = false;
          await sleep(Math.min(delay * 2 ** (this.#restartCount - 1), 1_000));
          continue;
        }
        if (this.#pendingRecovery === "control-plane") {
          this.#pendingRecovery = undefined;
          await this.#closeAttempt(false);
          await sleep(Math.min(delay * 2 ** (this.#restartCount - 1), 1_000));
          continue;
        }
        this.#restartCount = 0;
        this.#setStatus({ status: "ready" });
        return true;
      } catch {
        const pendingHost = this.#pendingRecovery === "host";
        this.#pendingRecovery = undefined;
        await this.#closeAttempt(service === "host" || pendingHost);
        if (pendingHost) service = "host";
        if (service === "control-plane" && this.#host === undefined) service = "host";
        if (hostReady && service === "host") this.#hostToken = this.#createHostToken();
        if (this.#restartCount < limit) {
          await sleep(Math.min(delay * 2 ** (this.#restartCount - 1), 1_000));
        }
      }
    }
    if (!this.#stopping) {
      this.#pendingRecovery = undefined;
      this.#setStatus({ status: "degraded", message: "Local runtime restart limit reached." });
    }
    return false;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#pendingRecovery = undefined;
    await this.#recovering;
    const host = this.#host;
    const controlPlane = this.#controlPlane;
    this.#removeHostExit();
    this.#removeControlPlaneExit();
    const lifecycleTimeout = this.#options.lifecycleTimeoutMs ?? DEFAULT_LIFECYCLE_TIMEOUT_MS;
    const closeTimeout = this.#options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    let lifecycleComplete = true;
    try {
      if (host !== undefined && controlPlane !== undefined) {
        for (const operation of [
          () => controlPlane.sendLifecycle("quiesce"),
          () => host.sendLifecycle("interrupt-and-drain"),
          () => controlPlane.sendLifecycle("interrupt-and-drain"),
          () => host.sendLifecycle("close"),
          () => controlPlane.sendLifecycle("close")
        ]) {
          await withTimeout(Promise.resolve().then(operation), lifecycleTimeout);
        }
      }
    } catch {
      lifecycleComplete = false;
    }

    const closeChild = async (child: RuntimeChild | undefined): Promise<boolean> => {
      if (child === undefined) return true;
      try {
        await withTimeout(
          Promise.resolve().then(async () => await child.close()),
          closeTimeout
        );
        return true;
      } catch {
        return false;
      }
    };
    const [hostClosed, controlPlaneClosed] = await Promise.all([
      closeChild(host),
      closeChild(controlPlane)
    ]);

    if (hostClosed && this.#host === host) {
      this.#host = undefined;
      this.#hostOrigin = undefined;
    }
    if (controlPlaneClosed && this.#controlPlane === controlPlane) {
      this.#controlPlane = undefined;
      this.#controlPlaneOrigin = undefined;
    }
    const complete = lifecycleComplete && hostClosed && controlPlaneClosed;
    if (this.#host === undefined && this.#controlPlane === undefined) {
      this.#hostToken = undefined;
      this.#startOptions = undefined;
    }
    this.#stopping = false;
    if (complete) {
      this.#setStatus({ status: "stopped" });
    } else {
      this.#setStatus({ status: "degraded", message: "Local runtime shutdown incomplete." });
    }
  }
}
