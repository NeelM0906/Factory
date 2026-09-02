/**
 * Channel binding store tests (Task 4c).
 */
import { describe, expect, it } from "vitest";

import {
  ChannelBindingSchema,
  WorkspaceIdSchema,
  type ChannelBinding
} from "@autostack/contracts";

import {
  BindingNotFoundError,
  createChannelBindingStore
} from "../src/channel-binding-store.js";

const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174000");

const slackBinding = ChannelBindingSchema.parse({
  schemaVersion: 1,
  bindingRef: "chb-slack-001",
  workspaceId: WORKSPACE_ID,
  provider: "slack",
  slackWorkspaceId: "T01234567",
  channelId: "C98765432",
  botCredentialRefId: "cred_123e4567-e89b-42d3-a456-426614174001",
  signingCredentialRefId: "cred_123e4567-e89b-42d3-a456-426614174002",
  enabled: true
});

const githubBinding = ChannelBindingSchema.parse({
  schemaVersion: 1,
  bindingRef: "chb-github-001",
  workspaceId: WORKSPACE_ID,
  provider: "github",
  installationId: "inst-123",
  repositoryId: "repo-456",
  repositoryFullName: "acme/widgets",
  credentialRefId: "cred_123e4567-e89b-42d3-a456-426614174003",
  projectId: "prj_123e4567-e89b-42d3-a456-426614174004",
  enabled: true
});

describe("createChannelBindingStore", () => {
  it("resolves a registered Slack binding by ref", async () => {
    const store = createChannelBindingStore();
    store.register(slackBinding);

    const resolved = await store.resolveByRef("chb-slack-001");
    expect(resolved).toEqual(slackBinding);
    expect(resolved.provider).toBe("slack");
  });

  it("resolves a registered GitHub binding by ref", async () => {
    const store = createChannelBindingStore();
    store.register(githubBinding);

    const resolved = await store.resolveByRef("chb-github-001");
    expect(resolved.provider).toBe("github");
    expect(resolved.bindingRef).toBe("chb-github-001");
  });

  it("throws BindingNotFoundError for an unknown ref", async () => {
    const store = createChannelBindingStore();

    await expect(store.resolveByRef("chb-nonexistent")).rejects.toBeInstanceOf(
      BindingNotFoundError
    );
  });

  it("overwrites a binding when re-registered with the same ref", async () => {
    const store = createChannelBindingStore();
    store.register(slackBinding);
    const disabled = { ...slackBinding, enabled: false };
    store.register(disabled);

    const resolved = await store.resolveByRef("chb-slack-001");
    expect(resolved.enabled).toBe(false);
  });
});
