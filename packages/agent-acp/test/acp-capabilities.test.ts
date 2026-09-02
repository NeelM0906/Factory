import { describe, expect, it } from "vitest";

import {
  negotiateAcpCapabilities,
  type AcpInitializeResult,
  type AcpSessionNewResult
} from "../src/acp-capabilities.js";

const fullInitResult: AcpInitializeResult = {
  protocolVersion: 1,
  agentInfo: { name: "example-acp-agent", version: "0.9.0" },
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, audio: false, embeddedContext: true },
    mcpCapabilities: { http: true, sse: false },
    sessionCapabilities: { list: {}, close: {} },
    auth: { logout: {} }
  },
  authMethods: [
    { id: "oauth-personal", name: "Sign in", description: "OAuth device-code flow." }
  ]
};

const fullSessionResult: AcpSessionNewResult = {
  sessionId: "sess_01k9m3q4r5s6t7u8v9w0x1y2",
  modes: {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Ask before editing" },
      { id: "acceptEdits", name: "Accept edits" }
    ]
  },
  configOptions: [
    {
      id: "model",
      name: "Model",
      type: "select",
      category: "model",
      currentValue: "example-large",
      availableValues: [{ id: "example-large", name: "Example Large" }]
    },
    {
      id: "reasoning-effort",
      name: "Reasoning effort",
      type: "select",
      category: "reasoning",
      currentValue: "medium",
      availableValues: [{ id: "medium", name: "Medium" }]
    }
  ]
};

const minimalInitResult: AcpInitializeResult = {
  protocolVersion: 1,
  agentInfo: { name: "example-acp-agent-minimal", version: "0.9.0" },
  agentCapabilities: {
    loadSession: false,
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
    mcpCapabilities: { http: false, sse: false },
    sessionCapabilities: {},
    auth: {}
  },
  authMethods: []
};

const minimalSessionResult: AcpSessionNewResult = {
  sessionId: "sess_01k9m3q4r5s6t7u8v9w0x1y2"
};

describe("negotiateAcpCapabilities", () => {
  describe("full-capability negotiation", () => {
    it("derives resume: true from loadSession: true", () => {
      const result = negotiateAcpCapabilities(fullInitResult, fullSessionResult, {
        permissionsConfigured: true
      });
      expect(result.descriptor.capabilities.resume).toBe(true);
    });

    it("derives permissions: true from the configured launch profile", () => {
      const result = negotiateAcpCapabilities(fullInitResult, fullSessionResult, {
        permissionsConfigured: true
      });
      expect(result.descriptor.capabilities.permissions).toBe(true);
    });

    it("derives structuredPlans from promptCapabilities", () => {
      const result = negotiateAcpCapabilities(fullInitResult, fullSessionResult, {
        permissionsConfigured: true
      });
      // The full fixture has embeddedContext: true, which implies structured plans
      expect(result.descriptor.capabilities.structuredPlans).toBe(true);
    });

    it("derives modelSelection from configOptions with category 'model'", () => {
      const result = negotiateAcpCapabilities(fullInitResult, fullSessionResult, {
        permissionsConfigured: true
      });
      expect(result.selection.modelSelection).toBe(true);
    });

    it("derives reasoningSelection from configOptions with category 'reasoning'", () => {
      const result = negotiateAcpCapabilities(fullInitResult, fullSessionResult, {
        permissionsConfigured: true
      });
      expect(result.selection.reasoningSelection).toBe(true);
    });

    it("populates permissionModes from available modes when permissions is true", () => {
      const result = negotiateAcpCapabilities(fullInitResult, fullSessionResult, {
        permissionsConfigured: true
      });
      expect(result.selection.permissionModes.length).toBeGreaterThan(0);
    });

    it("sets kind to 'acp'", () => {
      const result = negotiateAcpCapabilities(fullInitResult, fullSessionResult, {
        permissionsConfigured: true
      });
      expect(result.descriptor.kind).toBe("acp");
    });
  });

  describe("minimal-capability negotiation", () => {
    it("derives resume: false from loadSession: false", () => {
      const result = negotiateAcpCapabilities(minimalInitResult, minimalSessionResult, {
        permissionsConfigured: false
      });
      expect(result.descriptor.capabilities.resume).toBe(false);
    });

    it("derives permissions: false when not configured", () => {
      const result = negotiateAcpCapabilities(minimalInitResult, minimalSessionResult, {
        permissionsConfigured: false
      });
      expect(result.descriptor.capabilities.permissions).toBe(false);
    });

    it("the returned object has no respondToPermission property at all", () => {
      const result = negotiateAcpCapabilities(minimalInitResult, minimalSessionResult, {
        permissionsConfigured: false
      });
      expect("respondToPermission" in result).toBe(false);
    });

    it("permissionModes is empty when permissions is false", () => {
      const result = negotiateAcpCapabilities(minimalInitResult, minimalSessionResult, {
        permissionsConfigured: false
      });
      expect(result.selection.permissionModes).toEqual([]);
    });

    it("modelSelection is false when no configOptions are present", () => {
      const result = negotiateAcpCapabilities(minimalInitResult, minimalSessionResult, {
        permissionsConfigured: false
      });
      expect(result.selection.modelSelection).toBe(false);
    });

    it("reasoningSelection is false when no reasoning configOption is present", () => {
      const result = negotiateAcpCapabilities(minimalInitResult, minimalSessionResult, {
        permissionsConfigured: false
      });
      expect(result.selection.reasoningSelection).toBe(false);
    });
  });

  describe("fail-closed behavior", () => {
    it("an unparseable initialize result fails closed to the minimal descriptor", () => {
      const garbage = { protocolVersion: "not-a-number" } as unknown as AcpInitializeResult;
      const result = negotiateAcpCapabilities(
        garbage,
        minimalSessionResult,
        { permissionsConfigured: false }
      );
      expect(result.descriptor.capabilities.resume).toBe(false);
      expect(result.descriptor.capabilities.permissions).toBe(false);
      expect(result.descriptor.capabilities.structuredPlans).toBe(false);
      expect(result.descriptor.capabilities.steering).toBe(true); // ACP always supports steering
    });

    it("an absent initialize result fails closed", () => {
      const result = negotiateAcpCapabilities(
        undefined as unknown as AcpInitializeResult,
        minimalSessionResult,
        { permissionsConfigured: false }
      );
      expect(result.descriptor.capabilities.resume).toBe(false);
      expect(result.descriptor.capabilities.permissions).toBe(false);
    });
  });

  describe("distinct adapterId per negotiated profile", () => {
    it("full and minimal profiles have different adapterIds", () => {
      const full = negotiateAcpCapabilities(fullInitResult, fullSessionResult, {
        permissionsConfigured: true
      });
      const minimal = negotiateAcpCapabilities(minimalInitResult, minimalSessionResult, {
        permissionsConfigured: false
      });
      expect(full.descriptor.adapterId).not.toBe(minimal.descriptor.adapterId);
    });
  });
});
