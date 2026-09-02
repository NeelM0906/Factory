import {
  AgentHarnessDescriptorSchema,
  type AgentHarnessDescriptor,
  type AgentHarnessPort,
  type AgentHarnessProfile,
  type AgentPermissionResponderPort
} from "@autostack/contracts";

import { AgentRuntimeError } from "./errors.js";
import type { AgentHarnessAvailabilityFacts } from "./harness-availability.js";

/** One harness offered to the registry: the port, its selection surface, and its probe. */
export interface AgentHarnessRegistration {
  readonly harness: AgentHarnessPort & Partial<AgentPermissionResponderPort>;
  readonly selection: AgentHarnessProfile["selection"];
  probe(): Promise<AgentHarnessAvailabilityFacts>;
}

/**
 * Admits a registration or throws: the descriptor must parse, and the permission surface must
 * match the declared capability in BOTH directions — a declared capability without a responder is
 * as dishonest as an undeclared responder. The contract's structural rule (adapters without the
 * capability must not implement `AgentPermissionResponderPort`) becomes a registry invariant here,
 * so a dishonest adapter never enters the runtime at all.
 */
export const admitHarnessRegistration = (
  registration: AgentHarnessRegistration
): AgentHarnessDescriptor => {
  const descriptor = AgentHarnessDescriptorSchema.parse(registration.harness.descriptor);
  const exposesResponder = typeof registration.harness.respondToPermission === "function";
  if (descriptor.capabilities.permissions !== exposesResponder) {
    throw new AgentRuntimeError("agent_harness_capability_mismatch");
  }
  return descriptor;
};
