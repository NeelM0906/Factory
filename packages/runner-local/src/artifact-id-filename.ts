import { Buffer } from "node:buffer";

import type { ArtifactId } from "@autostack/contracts";

import { parseArtifactId } from "./artifact-types.js";

const CANONICAL_HEX_BYTES = /^(?:[0-9a-f]{2})+$/;

/** Encodes the exact accepted ID bytes into a case-insensitive-filesystem-safe component. */
export const encodeArtifactIdFilenameComponent = (artifactId: ArtifactId): string =>
  Buffer.from(artifactId, "utf8").toString("hex");

/** Decodes only canonical lowercase hex whose exact UTF-8 text is a contract-valid artifact ID. */
export const decodeArtifactIdFilenameComponent = (component: string): ArtifactId | undefined => {
  if (!CANONICAL_HEX_BYTES.test(component)) return undefined;
  const artifactId = Buffer.from(component, "hex").toString("utf8");
  if (Buffer.from(artifactId, "utf8").toString("hex") !== component) return undefined;
  try {
    return parseArtifactId(artifactId);
  } catch {
    return undefined;
  }
};
