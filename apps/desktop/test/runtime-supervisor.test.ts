import { describe, expect, it, vi } from "vitest";

import { RuntimeSupervisor, sanitizeUtilityEnvironment } from "../src/main/runtime-supervisor.js";

describe("RuntimeSupervisor", () => {
  it("retries a replacement host that fails before readiness and succeeds after root release", async () => {
    const launches: string[] = [];
    const exits = new Map<string, () => void>();
    let hostIndex = 0;
    let controlPlaneIndex = 0;
    const sleep = vi.fn(async () => undefined);
    const supervisor = new RuntimeSupervisor({
      launch: async (service) => {
        const index = service === "host" ? hostIndex++ : controlPlaneIndex++;
        const key = `${service}-${index}`;
        launches.push(key);
        const pid = launches.length;
        return {
          pid,
          postMessage: () => undefined,
          waitReady: async () => {
            if (key === "host-1") throw new Error("root_busy");
            return {
              service: service === "host" ? "autostack-host-daemon" : "autostack-control-plane",
              pid,
              origin: `http://127.0.0.1:${4600 + pid}`
            };
          },
          sendLifecycle: async () => undefined,
          close: async () => undefined,
          onExit: (listener) => {
            exits.set(key, listener);
            return () => exits.delete(key);
          }
        };
      },
      sleep,
      restartDelayMs: 1,
      restartLimit: 4
    });
    await supervisor.start({
      instanceId: "runtime_123e4567-e89b-42d3-a456-426614174000",
      hostToken: "host-token-0123456789abcdef0123456789",
      apiTokenDigest: "a".repeat(64),
      hostDataRoot: "/host",
      controlPlaneDataDirectory: "/cp",
      guardian: {} as never
    });

    exits.get("host-0")?.();
    await vi.waitFor(() => expect(supervisor.status()).toEqual({ status: "ready" }));
    expect(launches).toEqual(["host-0", "control-plane-0", "host-1", "host-2", "control-plane-1"]);
    expect(sleep).toHaveBeenCalled();
  });

  it("preserves a replacement-host exit that arrives while control-plane recovery is active", async () => {
    const launches: string[] = [];
    const exits = new Map<string, () => void>();
    let hostIndex = 0;
    let controlPlaneIndex = 0;
    let releaseControlPlane!: () => void;
    const delayedControlPlane = new Promise<void>((resolve) => {
      releaseControlPlane = resolve;
    });
    const supervisor = new RuntimeSupervisor({
      launch: async (service) => {
        const index = service === "host" ? hostIndex++ : controlPlaneIndex++;
        const key = `${service}-${index}`;
        launches.push(key);
        const pid = launches.length;
        return {
          pid,
          postMessage: () => undefined,
          waitReady: async () => {
            if (key === "control-plane-1") await delayedControlPlane;
            return {
              service: service === "host" ? "autostack-host-daemon" : "autostack-control-plane",
              pid,
              origin: `http://127.0.0.1:${4700 + pid}`
            };
          },
          sendLifecycle: async () => undefined,
          close: async () => undefined,
          onExit: (listener) => {
            exits.set(key, listener);
            return () => exits.delete(key);
          }
        };
      },
      sleep: async () => undefined,
      restartDelayMs: 1,
      restartLimit: 4
    });
    await supervisor.start({
      instanceId: "runtime_123e4567-e89b-42d3-a456-426614174000",
      hostToken: "host-token-0123456789abcdef0123456789",
      apiTokenDigest: "a".repeat(64),
      hostDataRoot: "/host",
      controlPlaneDataDirectory: "/cp",
      guardian: {} as never
    });

    exits.get("host-0")?.();
    await vi.waitFor(() => expect(exits.has("host-1")).toBe(true));
    exits.get("host-1")?.();
    releaseControlPlane();
    await vi.waitFor(() => expect(supervisor.status()).toEqual({ status: "ready" }));
    expect(launches).toEqual([
      "host-0",
      "control-plane-0",
      "host-1",
      "control-plane-1",
      "host-2",
      "control-plane-2"
    ]);
  });

  it("retires the old control plane and restarts the full generation after host loss", async () => {
    const launches: string[] = [];
    const exits = new Map<string, () => void>();
    const lifecycle: string[] = [];
    const bootstraps = new Map<string, unknown>();
    let generation = 0;
    const supervisor = new RuntimeSupervisor({
      launch: async (service) => {
        const key = `${service}-${generation}`;
        launches.push(key);
        if (service === "control-plane") generation += 1;
        return {
          pid: launches.length,
          postMessage: (message) => bootstraps.set(key, message),
          waitReady: async () => ({
            service: service === "host" ? "autostack-host-daemon" : "autostack-control-plane",
            pid: launches.length,
            origin: `http://127.0.0.1:${4500 + launches.length}`
          }),
          sendLifecycle: async (type) => {
            lifecycle.push(`${key}:${type}`);
            if (type === "retire-generation") return { incomplete: true };
            return { remainingReconciliationCount: 0 };
          },
          close: async () => undefined,
          onExit: (listener) => {
            exits.set(key, listener);
            return () => exits.delete(key);
          }
        };
      },
      createHostToken: () => `fresh-${crypto.randomUUID()}-0123456789abcdef`
    });
    await supervisor.start({
      instanceId: "runtime_123e4567-e89b-42d3-a456-426614174000",
      apiTokenDigest: "a".repeat(64),
      hostDataRoot: "/host",
      controlPlaneDataDirectory: "/cp",
      guardian: {} as never
    });
    exits.get("host-0")?.();
    await vi.waitFor(() =>
      expect(launches).toEqual(["host-0", "control-plane-0", "host-1", "control-plane-1"])
    );
    expect(supervisor.status()).toEqual({ status: "ready" });
    expect(lifecycle).toContain("control-plane-0:retire-generation");
    expect((bootstraps.get("host-0") as { hostToken: string }).hostToken).not.toBe(
      (bootstraps.get("host-1") as { hostToken: string }).hostToken
    );
    await supervisor.stop();
    expect(supervisor.status()).toEqual({ status: "stopped" });
  });

  it("starts host before control plane and sends secrets only over one-shot bootstrap messages", async () => {
    const launches: Array<{ service: string; env: NodeJS.ProcessEnv; messages: unknown[] }> = [];
    const supervisor = new RuntimeSupervisor({
      launch: async (service, env) => {
        const child = { service, env, messages: [] as unknown[] };
        launches.push(child);
        return {
          pid: service === "host" ? 101 : 102,
          postMessage: (message) => child.messages.push(message),
          waitReady: async () => ({
            service: service === "host" ? "autostack-host-daemon" : "autostack-control-plane",
            pid: service === "host" ? 101 : 102,
            origin: service === "host" ? "http://127.0.0.1:4401" : "http://127.0.0.1:4402"
          }),
          sendLifecycle: async () => ({ remainingReconciliationCount: 0 }),
          close: async () => undefined
        };
      },
      environment: {
        PATH: "/bin",
        LANG: "en_US.UTF-8",
        HOME: "/secret/home",
        NODE_OPTIONS: "--require steal.js",
        GITHUB_TOKEN: "secret",
        DYLD_INSERT_LIBRARIES: "steal.dylib"
      }
    });

    await supervisor.start({
      instanceId: "runtime_123e4567-e89b-42d3-a456-426614174000",
      hostToken: "host-secret",
      apiTokenDigest: "a".repeat(64),
      hostDataRoot: "/private/host",
      controlPlaneDataDirectory: "/private/control-plane",
      guardian: {} as never
    });

    expect(launches.map((launch) => launch.service)).toEqual(["host", "control-plane"]);
    expect(launches[0]?.env).toEqual({ LANG: "en_US.UTF-8", PATH: "/bin" });
    expect(JSON.stringify(launches.map((launch) => launch.env))).not.toContain("secret");
    expect(launches[0]?.messages).toHaveLength(1);
    expect(launches[1]?.messages).toHaveLength(1);
    expect(supervisor.status()).toEqual({ status: "ready" });
  });

  it("uses the evidence-preserving shutdown order", async () => {
    const events: string[] = [];
    const supervisor = new RuntimeSupervisor({
      launch: async (service) => ({
        pid: service === "host" ? 1 : 2,
        postMessage: () => undefined,
        waitReady: async () => ({
          service: service === "host" ? "autostack-host-daemon" : "autostack-control-plane",
          pid: service === "host" ? 1 : 2,
          origin: service === "host" ? "http://127.0.0.1:4001" : "http://127.0.0.1:4002"
        }),
        sendLifecycle: async (type) => {
          events.push(`${service}:${type}`);
          return { remainingReconciliationCount: 0 };
        },
        close: async () => {
          events.push(`${service}:closed`);
        }
      })
    });
    await supervisor.start({
      instanceId: "runtime_123e4567-e89b-42d3-a456-426614174000",
      hostToken: "host",
      apiTokenDigest: "a".repeat(64),
      hostDataRoot: "/host",
      controlPlaneDataDirectory: "/cp",
      guardian: {} as never
    });
    await supervisor.stop();
    expect(events).toEqual([
      "control-plane:quiesce",
      "host:interrupt-and-drain",
      "control-plane:interrupt-and-drain",
      "host:close",
      "control-plane:close",
      "host:closed",
      "control-plane:closed"
    ]);
    expect(supervisor.status()).toEqual({ status: "stopped" });
  });

  it("does not begin host drain until control-plane quiesce is acknowledged", async () => {
    const events: string[] = [];
    let acknowledgeQuiesce!: () => void;
    const quiesced = new Promise<void>((resolve) => {
      acknowledgeQuiesce = resolve;
    });
    const supervisor = new RuntimeSupervisor({
      launch: async (service) => ({
        pid: service === "host" ? 11 : 12,
        postMessage: () => undefined,
        waitReady: async () => ({
          service: service === "host" ? "autostack-host-daemon" : "autostack-control-plane",
          pid: service === "host" ? 11 : 12,
          origin: service === "host" ? "http://127.0.0.1:4011" : "http://127.0.0.1:4012"
        }),
        sendLifecycle: async (type) => {
          events.push(`${service}:${type}`);
          if (service === "control-plane" && type === "quiesce") await quiesced;
          return undefined;
        },
        requestDesktop: async () => {
          events.push(`${service}:desktop-start-executed`);
          return {};
        },
        close: async () => undefined
      })
    });
    await supervisor.start({
      instanceId: "runtime_123e4567-e89b-42d3-a456-426614174000",
      hostToken: "host",
      apiTokenDigest: "a".repeat(64),
      hostDataRoot: "/host",
      controlPlaneDataDirectory: "/cp",
      guardian: {} as never
    });

    const stopping = supervisor.stop();
    await vi.waitFor(() => expect(events).toContain("control-plane:quiesce"));
    expect(events).not.toContain("host:interrupt-and-drain");
    await expect(
      supervisor.dispatchLocal({ operation: "local.start", runId: "run_pending" })
    ).rejects.toThrow("Desktop local-operation dispatcher unavailable.");
    acknowledgeQuiesce();
    await stopping;

    expect(events).not.toContain("control-plane:desktop-start-executed");
    expect(events.indexOf("control-plane:quiesce")).toBeLessThan(
      events.indexOf("host:interrupt-and-drain")
    );
  });

  it("bounds a hung lifecycle step, closes both children, and reports degraded", async () => {
    const events: string[] = [];
    const never = new Promise<never>(() => undefined);
    const supervisor = new RuntimeSupervisor({
      lifecycleTimeoutMs: 5,
      closeTimeoutMs: 5,
      launch: async (service) => ({
        pid: service === "host" ? 21 : 22,
        postMessage: () => undefined,
        waitReady: async () => ({
          service: service === "host" ? "autostack-host-daemon" : "autostack-control-plane",
          pid: service === "host" ? 21 : 22,
          origin: service === "host" ? "http://127.0.0.1:4021" : "http://127.0.0.1:4022"
        }),
        sendLifecycle: async (type) => {
          events.push(`${service}:${type}`);
          if (service === "control-plane" && type === "quiesce") return await never;
          return undefined;
        },
        close: async () => void events.push(`${service}:closed`)
      })
    });
    await supervisor.start({
      instanceId: "runtime_123e4567-e89b-42d3-a456-426614174000",
      hostToken: "host",
      apiTokenDigest: "a".repeat(64),
      hostDataRoot: "/host",
      controlPlaneDataDirectory: "/cp",
      guardian: {} as never
    });

    await supervisor.stop();

    expect(events).toContain("host:closed");
    expect(events).toContain("control-plane:closed");
    expect(supervisor.status()).toEqual({
      status: "degraded",
      message: "Local runtime shutdown incomplete."
    });
  });

  it("attempts both child closes after rejection and retains a failed close for retry", async () => {
    const closes = { host: 0, controlPlane: 0 };
    const supervisor = new RuntimeSupervisor({
      lifecycleTimeoutMs: 5,
      closeTimeoutMs: 5,
      launch: async (service) => ({
        pid: service === "host" ? 31 : 32,
        postMessage: () => undefined,
        waitReady: async () => ({
          service: service === "host" ? "autostack-host-daemon" : "autostack-control-plane",
          pid: service === "host" ? 31 : 32,
          origin: service === "host" ? "http://127.0.0.1:4031" : "http://127.0.0.1:4032"
        }),
        sendLifecycle: async (type) => {
          if (service === "host" && type === "interrupt-and-drain") {
            throw new Error("host drain rejected");
          }
          return undefined;
        },
        close: async () => {
          if (service === "host") {
            closes.host += 1;
            if (closes.host === 1) throw new Error("host close rejected");
          } else {
            closes.controlPlane += 1;
          }
        }
      })
    });
    await supervisor.start({
      instanceId: "runtime_123e4567-e89b-42d3-a456-426614174000",
      hostToken: "host",
      apiTokenDigest: "a".repeat(64),
      hostDataRoot: "/host",
      controlPlaneDataDirectory: "/cp",
      guardian: {} as never
    });

    await supervisor.stop();
    expect(closes).toEqual({ host: 1, controlPlane: 1 });
    expect(supervisor.status().status).toBe("degraded");

    await supervisor.stop();
    expect(closes).toEqual({ host: 2, controlPlane: 1 });
    expect(supervisor.status().status).toBe("stopped");
  });
});
