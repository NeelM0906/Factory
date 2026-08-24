import { describe, expect, it, vi } from "vitest";

const prepareEnvironmentWithReplay = vi.fn();
const terminalizeProtocolFailure = vi.fn();

vi.mock("@autostack/runner-local", () => ({
  localRunnerHostControl: () => ({ prepareEnvironmentWithReplay, terminalizeProtocolFailure })
}));

import { bindLocalRunnerProvider } from "../src/server.js";

describe("local provider host binding", () => {
  it("binds host-only control and fixes the quarantine reason", async () => {
    const provider = { quiesce: vi.fn(), interruptAndDrain: vi.fn(), close: vi.fn() };
    const composition = bindLocalRunnerProvider(provider as never);
    const request = { commandId: "cmd" } as never;
    await composition.prepareWithReplay(request);
    await composition.terminalizeProtocolFailure(request);
    expect(prepareEnvironmentWithReplay).toHaveBeenCalledWith(request);
    expect(terminalizeProtocolFailure).toHaveBeenCalledWith(request, "output_quarantined");
    expect(composition.runner).toBe(provider);
    expect(composition.lifecycle).toBe(provider);
  });
});
