/**
 * Channel binding store (Task 4c).
 *
 * Provides `resolveBindingByRef` for the Slack integration's dependency injection.
 * Bindings are registered at startup (from configuration or database) and looked up
 * by their opaque `bindingRef`. The store enforces that every returned binding passes
 * `ChannelBindingSchema` validation.
 *
 * This is the composition-root layer: the Slack integration never touches the store
 * directly — it only receives `resolveBindingByRef` as a callback.
 */

import {
  ChannelBindingSchema,
  type ChannelBinding
} from "@autostack/contracts";

export class BindingNotFoundError extends Error {
  constructor(bindingRef: string) {
    super(`No channel binding found for ref ${bindingRef}.`);
    this.name = "BindingNotFoundError";
  }
}

export class BindingDisabledError extends Error {
  constructor(bindingRef: string) {
    super(`Channel binding ${bindingRef} is disabled.`);
    this.name = "BindingDisabledError";
  }
}

export interface ChannelBindingStore {
  register(binding: ChannelBinding): void;
  resolveByRef(bindingRef: string): Promise<ChannelBinding>;
}

export function createChannelBindingStore(): ChannelBindingStore {
  const bindings = new Map<string, ChannelBinding>();

  return {
    register(binding: ChannelBinding): void {
      const validated = ChannelBindingSchema.parse(binding);
      bindings.set(validated.bindingRef, validated);
    },

    resolveByRef: async (bindingRef: string): Promise<ChannelBinding> => {
      const binding = bindings.get(bindingRef);
      if (binding === undefined) {
        throw new BindingNotFoundError(bindingRef);
      }
      return binding;
    }
  };
}
