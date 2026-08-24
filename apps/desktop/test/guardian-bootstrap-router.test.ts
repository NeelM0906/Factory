import { describe, expect, it, vi } from "vitest";

import {
  GuardianBootstrapRouter,
  type GuardianMessageRuntime
} from "../src/guardian/bootstrap-router.js";

describe("guardian bootstrap router", () => {
  it("delivers the fast parent lease-transfer reply after runtime bootstrap completes", async () => {
    let finishBootstrap!: (runtime: GuardianMessageRuntime<string>) => void;
    const bootstrap = new Promise<GuardianMessageRuntime<string>>((resolve) => {
      finishBootstrap = resolve;
    });
    const receive = vi.fn(async () => undefined);
    const runtime = { receive, disconnect: vi.fn(async () => undefined) };
    const router = GuardianBootstrapRouter.create<string, string>({
      bootstrap: async () => await bootstrap,
      onFailure: vi.fn()
    });

    const bootstrapping = router.route("guardian.bootstrap");
    const transferring = router.route("host.lease_transfer");
    expect(receive).not.toHaveBeenCalled();

    finishBootstrap(runtime);
    await Promise.all([bootstrapping, transferring]);

    expect(receive).toHaveBeenCalledOnce();
    expect(receive).toHaveBeenCalledWith("host.lease_transfer");
  });

  it("fails closed instead of growing the pre-runtime queue", async () => {
    const onFailure = vi.fn();
    const router = GuardianBootstrapRouter.create<string, string>({
      bootstrap: async () => await new Promise<GuardianMessageRuntime<string>>(() => undefined),
      onFailure
    });

    void router.route("guardian.bootstrap");
    const queued = router.route("host.lease_transfer");
    const overflow = router.route("host.unexpected");

    await expect(overflow).rejects.toThrow("saturated");
    await expect(queued).rejects.toThrow("saturated");
    expect(onFailure).toHaveBeenCalledOnce();
  });
});
