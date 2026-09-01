import type {
  AgentHarnessDescriptor,
  AgentHarnessPort,
  AgentHarnessProfile,
  AgentPermissionResponderPort
} from "@autostack/contracts";

import { AgentRuntimeError } from "./errors.js";
import { describeHarnessAvailability } from "./harness-availability.js";
import { admitHarnessRegistration, type AgentHarnessRegistration } from "./harness-registration.js";

export type { AgentHarnessRegistration } from "./harness-registration.js";

export interface AgentHarnessRegistry {
  register(registration: AgentHarnessRegistration): void;
  get(adapterId: string): AgentHarnessPort & Partial<AgentPermissionResponderPort>;
  listByKind(kind: AgentHarnessDescriptor["kind"]): readonly AgentHarnessDescriptor[];
  profiles(): Promise<readonly AgentHarnessProfile[]>;
}

/** The clock and probe budget are injected once here and shared by every profile construction. */
export interface CreateAgentHarnessRegistryOptions {
  readonly now: () => string;
  readonly probeTimeout: () => Promise<void>;
}

interface AdmittedRegistration {
  readonly registration: AgentHarnessRegistration;
  readonly descriptor: AgentHarnessDescriptor;
}

export const createAgentHarnessRegistry = (
  options: CreateAgentHarnessRegistryOptions
): AgentHarnessRegistry => {
  // Insertion order is the registration order listByKind and profiles() report in.
  const admitted = new Map<string, AdmittedRegistration>();

  const register = (registration: AgentHarnessRegistration): void => {
    const descriptor = admitHarnessRegistration(registration);
    if (admitted.has(descriptor.adapterId)) {
      throw new AgentRuntimeError("agent_harness_already_registered");
    }
    admitted.set(descriptor.adapterId, { registration, descriptor });
  };

  const get = (adapterId: string): AgentHarnessPort & Partial<AgentPermissionResponderPort> => {
    const entry = admitted.get(adapterId);
    if (entry === undefined) {
      throw new AgentRuntimeError("agent_harness_not_registered");
    }
    return entry.registration.harness;
  };

  const listByKind = (kind: AgentHarnessDescriptor["kind"]): readonly AgentHarnessDescriptor[] =>
    [...admitted.values()]
      .filter((entry) => entry.descriptor.kind === kind)
      .map((entry) => entry.descriptor);

  /**
   * Every probe is started before any is awaited, and each `describeHarnessAvailability` call
   * fails closed internally and never rejects — so `Promise.all` cannot let one broken probe
   * erase the other profiles.
   */
  const profiles = async (): Promise<readonly AgentHarnessProfile[]> =>
    Promise.all(
      [...admitted.values()].map((entry) =>
        describeHarnessAvailability({
          descriptor: entry.descriptor,
          selection: entry.registration.selection,
          probe: () => entry.registration.probe(),
          now: options.now,
          probeTimeout: options.probeTimeout
        })
      )
    );

  return { register, get, listByKind, profiles };
};
