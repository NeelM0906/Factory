import { describe, expect, it, vi } from "vitest";

import { createReadinessPublisher } from "../src/readiness.js";

describe("readiness", () => {
  it("publishes exactly one verified loopback record", async () => {
    const write = vi.fn();
    const publisher = createReadinessPublisher({ writeOnce: write });
    await publisher.publish({ address: "127.0.0.1", family: "IPv4", port: 4242 }, 99);
    await expect(
      publisher.publish({ address: "127.0.0.1", family: "IPv4", port: 4242 }, 99)
    ).rejects.toThrow("Readiness was already published.");
    expect(write).toHaveBeenCalledOnce();
  });

  it.each([
    { address: "0.0.0.0", family: "IPv4", port: 1 },
    { address: "127.0.0.1", family: "IPv6", port: 1 },
    { address: "127.0.0.1", family: "IPv4", port: 0 },
    { address: "127.0.0.1", family: "IPv4", port: 65_536 }
  ])("rejects an unverified listener %j", async (address) => {
    await expect(
      createReadinessPublisher({ writeOnce: vi.fn() }).publish(address, 1)
    ).rejects.toThrow("Host listener is not verified loopback.");
  });
});
