/**
 * ACP harness — the AgentHarnessPort implementation for ACP agents.
 *
 * Composes: EventSequencer, AcpEventMapper, AcpFailureClassifier, ChildSession.
 * The harness launches an ACP agent as a child process, negotiates via JSON-RPC,
 * and normalizes the stdio stream into AgentSessionStreamEvent.
 */

import {
  EventSequencer,
  type AgentEvidenceSink
} from "@autostack/agent-adapter-kit";

import { mapAcpFrame, buildUnknownUsage, type AcpMapperContext } from "./acp-event-mapper.js";
import { classifyAcpFailure } from "./acp-failures.js";

import type {
  AgentHarnessDescriptor,
  AgentHarnessPort,
  AgentPermissionResponderPort,
  AgentInvocationRequest,
  AgentResumeRequest,
  AgentSteerRequest,
  AgentCancelRequest,
  AgentPermissionResponse,
  AgentSessionStreamEvent
} from "@autostack/contracts";

// ---- Options ----

export interface AcpHarnessOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly evidenceSink: AgentEvidenceSink;
  readonly permissionsConfigured: boolean;
  readonly structuredPlans: boolean;
}

// ---- AcpHarness ----

export class AcpHarness implements AgentHarnessPort {
  readonly #options: AcpHarnessOptions;
  readonly #sequencer: EventSequencer;
  readonly #descriptor: AgentHarnessDescriptor;
  #disposed = false;

  private constructor(options: AcpHarnessOptions) {
    this.#options = options;
    this.#sequencer = new EventSequencer();
    this.#descriptor = {
      schemaVersion: 1 as const,
      adapterId: "acp/unknown/full",
      kind: "acp",
      displayName: "ACP Agent",
      capabilities: {
        resume: false,
        steering: true,
        permissions: options.permissionsConfigured,
        structuredPlans: options.structuredPlans
      }
    };
  }

  static create(options: AcpHarnessOptions): AcpHarness {
    return new AcpHarness(options);
  }

  get descriptor(): AgentHarnessDescriptor {
    return this.#descriptor;
  }

  async *start(request: AgentInvocationRequest): AsyncIterable<AgentSessionStreamEvent> {
    this.#assertNotDisposed();
    // Placeholder — full implementation in Task 6 (conformance suite) wires the child
    throw new Error("AcpHarness.start() not yet fully implemented.");
  }

  async *resume(request: AgentResumeRequest): AsyncIterable<AgentSessionStreamEvent> {
    this.#assertNotDisposed();
    throw new Error("AcpHarness.resume() not yet fully implemented.");
  }

  async steer(request: AgentSteerRequest): Promise<void> {
    this.#assertNotDisposed();
    throw new Error("AcpHarness.steer() not yet fully implemented.");
  }

  async cancel(request: AgentCancelRequest): Promise<void> {
    this.#assertNotDisposed();
    throw new Error("AcpHarness.cancel() not yet fully implemented.");
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
  }

  #assertNotDisposed(): void {
    if (this.#disposed) {
      throw new Error("AcpHarness has been disposed.");
    }
  }
}
