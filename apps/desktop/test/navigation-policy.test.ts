import { describe, expect, it, vi } from "vitest";

import { createNavigationPolicy } from "../src/main/navigation-policy.js";

describe("desktop navigation policy", () => {
  it("allows only the bundled renderer and an explicit numeric-loopback development origin", () => {
    const policy = createNavigationPolicy({
      productionUrl: "file:///app/dist/renderer/index.html",
      developmentOrigin: "http://127.0.0.1:5173"
    });
    expect(policy.allowsNavigation("file:///app/dist/renderer/index.html")).toBe(true);
    expect(policy.allowsNavigation("http://127.0.0.1:5173/settings")).toBe(true);
    expect(policy.allowsNavigation("http://localhost:5173")).toBe(false);
    expect(policy.allowsNavigation("https://example.com")).toBe(false);
  });

  it("denies permissions, windows, downloads, and unexpected navigation", () => {
    const policy = createNavigationPolicy({ productionUrl: "file:///app/index.html" });
    const preventDefault = vi.fn();
    expect(policy.permissionRequest()).toBe(false);
    expect(policy.windowOpen()).toEqual({ action: "deny" });
    policy.download({ preventDefault });
    policy.navigation("https://example.com", { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });
});
