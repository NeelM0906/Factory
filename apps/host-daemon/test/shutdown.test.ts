import { describe, expect, it, vi } from "vitest";

import { createHostIngressState, createShutdownController } from "../src/shutdown.js";

describe("host shutdown", () => {
  it("quiesces, drains to zero leases, and closes once", async () => {
    const calls: string[] = [];
    const lifecycle = {
      quiesce: vi.fn(async () => void calls.push("quiesce")),
      interruptAndDrain: vi.fn(async () => {
        calls.push("drain");
        return {
          interruptedCommandIds: ["cmd_12345678-1234-4123-8123-123456789abc"],
          releasedGuardianLeaseCount: 1,
          remainingGuardianLeaseCount: 0 as const
        };
      }),
      close: vi.fn(async () => void calls.push("close"))
    };
    const ingress = createHostIngressState();
    const controller = createShutdownController({ lifecycle: lifecycle as never, ingress });
    await controller.quiesce();
    expect(ingress.acceptsMutation()).toBe(false);
    await controller.interruptAndDrain();
    await controller.close();
    await controller.close();
    expect(calls).toEqual(["quiesce", "drain", "close"]);
  });

  it("does not acknowledge an incomplete drain", async () => {
    const controller = createShutdownController({
      lifecycle: {
        quiesce: vi.fn(),
        interruptAndDrain: vi.fn(async () => ({
          interruptedCommandIds: ["cmd_12345678-1234-4123-8123-123456789abc"],
          releasedGuardianLeaseCount: 0,
          remainingGuardianLeaseCount: 1 as never
        })),
        close: vi.fn()
      } as never,
      ingress: createHostIngressState()
    });
    await expect(controller.interruptAndDrain()).rejects.toThrow("Host drain is incomplete.");
  });

  it("fails closed when lifecycle close fails", async () => {
    const ingress = createHostIngressState();
    const controller = createShutdownController({
      lifecycle: {
        quiesce: async () => undefined,
        interruptAndDrain: async () => ({
          interruptedCommandIds: [],
          releasedGuardianLeaseCount: 0,
          remainingGuardianLeaseCount: 0
        }),
        close: async () => {
          throw new Error("close failed");
        }
      },
      ingress
    });
    await expect(controller.close()).rejects.toThrow("close failed");
    expect(ingress.state()).toBe("failed");
  });
});
