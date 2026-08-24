import { describe, expect, it } from "vitest";

import { createWindowConfiguration } from "../src/main/window.js";

describe("desktop window configuration", () => {
  it("enables Chromium isolation and loads only the provided preload", () => {
    const configuration = createWindowConfiguration("/build/preload/index.js");
    expect(configuration.webPreferences).toEqual({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: "/build/preload/index.js"
    });
    expect(configuration).not.toHaveProperty("webviewTag");
  });
});
