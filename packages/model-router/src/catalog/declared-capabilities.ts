import { z } from "zod";

import {
  ModelCatalogEntrySchema,
  ModelFeatureSchema,
  ModelModalitySchema,
  type ModelCatalogEntry
} from "@autostack/contracts";

/**
 * Operator-declared capability override for a named provider model (DEC-1). OpenAI's and
 * Anthropic's model-list endpoints publish ids and display names only, so a discovered entry with
 * no provider-published capability metadata gets the conservative floor unless the operator has
 * declared capabilities for it here. This is a router-local, versioned configuration input, not a
 * contract change.
 *
 * Declarations are validated against the contract's closed vocabularies (`MODEL_MODALITIES`,
 * `MODEL_FEATURES`) at CONSTRUCTION, not at discovery — an operator typo becomes a startup failure
 * instead of a silently ignored override.
 */
const DeclaredCapabilityEntrySchema = z
  .object({
    inputModalities: z.array(ModelModalitySchema).min(1),
    outputModalities: z.array(ModelModalitySchema).min(1),
    features: z.array(ModelFeatureSchema)
  })
  .strict();

export type DeclaredCapabilityEntry = z.infer<typeof DeclaredCapabilityEntrySchema>;

export interface DeclaredCapabilityDeclaration {
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly features: readonly string[];
}

export type DeclaredCapabilitiesInput = Readonly<Record<string, DeclaredCapabilityDeclaration>>;

export interface DeclaredCapabilities {
  get(providerModel: string): DeclaredCapabilityEntry | undefined;
}

/** Validates every declaration eagerly, so a bad entry fails the moment the map is built. */
export const createDeclaredCapabilities = (
  declarations: DeclaredCapabilitiesInput
): DeclaredCapabilities => {
  const parsed = new Map<string, DeclaredCapabilityEntry>();
  for (const [providerModel, declaration] of Object.entries(declarations)) {
    parsed.set(providerModel, DeclaredCapabilityEntrySchema.parse(declaration));
  }
  return {
    get: (providerModel: string): DeclaredCapabilityEntry | undefined => parsed.get(providerModel)
  };
};

/**
 * Applies declared overrides to already-discovered entries. This runs strictly AFTER parsing: it
 * only ever replaces the capability fields of an entry the provider actually returned. A
 * declaration keyed to a `providerModel` the provider did not list has nothing to attach to and is
 * silently inert — configuration cannot resurrect a model the provider never offered.
 */
export const applyDeclaredCapabilities = (
  entries: readonly ModelCatalogEntry[],
  declaredCapabilities: DeclaredCapabilities | undefined
): ModelCatalogEntry[] => {
  if (declaredCapabilities === undefined) return entries.slice();
  return entries.map((entry) => {
    const declared = declaredCapabilities.get(entry.providerModel);
    if (declared === undefined) return entry;
    return ModelCatalogEntrySchema.parse({
      ...entry,
      inputModalities: declared.inputModalities,
      outputModalities: declared.outputModalities,
      features: declared.features
    });
  });
};
