import { afterEach, describe, expect, it } from "vitest";

import { ArtifactIdSchema, createId, type ArtifactDescriptor } from "@autostack/contracts";

import { EventBackedLocalExecutionState } from "../src/local-execution-state.js";

import {
  NOW,
  closeSeededRun,
  preparedEnvironmentFor,
  seedApprovedRun,
  type SeededRun
} from "./fixtures/seed-approved-run.js";

const seeded: SeededRun[] = [];

const openState = (run: SeededRun) =>
  new EventBackedLocalExecutionState({
    store: run.store,
    workspaceId: run.workspaceId,
    now: () => NOW
  });

const seed = async (...args: Parameters<typeof seedApprovedRun>) => {
  const run = await seedApprovedRun(...args);
  if (args[0]?.reuse === undefined) seeded.push(run);
  return run;
};

const prepareInput = (run: SeededRun) => ({
  runId: run.runId,
  approvalId: run.environmentAuthorization.approvalId,
  environmentAuthorizationId: run.environmentAuthorization.id,
  environmentId: run.environmentId,
  sourcePath: "/repo",
  baseRef: "main",
  branchSlug: run.branchSlug
});

const startInput = (run: SeededRun) => ({
  runId: run.runId,
  approvalId: run.commandAuthorization.approvalId,
  commandAuthorizationId: run.commandAuthorization.id,
  environmentId: run.environmentId,
  commandId: run.commandId,
  command: run.command
});

/** Drives the state through preparation so the run reaches `implementing`. */
const prepared = async (run: SeededRun) => {
  const state = openState(run);
  const request = await state.authorizePreparation(
    prepareInput(run) as never,
    run.inspection,
    `prepare:${run.runId}`
  );
  await state.recordPreparationIntent(request);
  await state.recordPrepared(request, preparedEnvironmentFor(run) as never);
  return { state, request };
};

/** Drives the state through preparation and command intent. */
const started = async (run: SeededRun) => {
  const { state } = await prepared(run);
  const start = await state.authorizeStart(startInput(run) as never, `start:${run.runId}`);
  await state.recordCommandIntent(start);
  return { state, start };
};

const transcript = (run: SeededRun, artifactId: string): ArtifactDescriptor =>
  ({
    artifactId: ArtifactIdSchema.parse(artifactId),
    workspaceId: run.workspaceId,
    runId: run.runId,
    commandId: run.commandId,
    kind: "command_transcript",
    mediaType: "text/plain; charset=utf-8",
    digest: "c".repeat(64),
    byteSize: 9,
    createdAt: NOW
  }) as ArtifactDescriptor;

const completion = (run: SeededRun, overrides: Record<string, unknown> = {}) =>
  ({
    type: "command.completed",
    workspaceId: run.workspaceId,
    runId: run.runId,
    commandId: run.commandId,
    sequence: 4,
    occurredAt: NOW,
    exitCode: 0,
    signal: null,
    interrupted: false,
    cancelled: false,
    transcript: {
      artifactId: ArtifactIdSchema.parse("art_123e4567-e89b-42d3-a456-4266141743a0")
    },
    ...overrides
  }) as never;

afterEach(async () => {
  for (const run of seeded.splice(0)) await closeSeededRun(run);
});

describe("EventBackedLocalExecutionState authorization", () => {
  it("binds a preparation request to the durable authorization scope, not to caller-supplied values", async () => {
    const run = await seed();
    const state = openState(run);

    const request = await state.authorizePreparation(
      prepareInput(run) as never,
      run.inspection,
      "prepare-1"
    );

    expect(request.workspaceId).toBe(run.workspaceId);
    expect(request.environmentId).toBe(run.environmentId);
    expect(request.branch).toBe(run.branch);
    expect(request.sourceCommit).toBe(run.environmentAuthorization.scope.sourceCommit);
    expect(request.authorization).toEqual(run.environmentAuthorization);
    expect(request.idempotency).toEqual({ key: "prepare-1" });
  });

  it("rejects a preparation whose branch slug does not match the authorized branch", async () => {
    const run = await seed();
    const state = openState(run);

    await expect(
      state.authorizePreparation(
        { ...prepareInput(run), branchSlug: "other-slice" } as never,
        run.inspection,
        "prepare-1"
      )
    ).rejects.toThrow(/Environment authorization is invalid/);
  });

  it("rejects a preparation that claims an approval the authorization was not issued under", async () => {
    const run = await seed();
    const state = openState(run);

    await expect(
      state.authorizePreparation(
        { ...prepareInput(run), approvalId: run.commandApprovalId } as never,
        run.inspection,
        "prepare-1"
      )
    ).rejects.toThrow(/Environment authorization is invalid/);
  });

  it("rejects a preparation naming an authorization that is not durable in the run stream", async () => {
    const run = await seed();
    const state = openState(run);

    await expect(
      state.authorizePreparation(
        {
          ...prepareInput(run),
          environmentAuthorizationId: createId(
            "environmentAuthorization",
            "123e4567-e89b-42d3-a456-4266141749ff"
          )
        } as never,
        run.inspection,
        "prepare-1"
      )
    ).rejects.toThrow(/Environment authorization is invalid/);
  });

  it("refuses to build a preparation request whose inspected commit drifts from the authorized commit", async () => {
    const run = await seed();
    const state = openState(run);

    await expect(
      state.authorizePreparation(
        prepareInput(run) as never,
        { ...run.inspection, sourceCommit: "e".repeat(40) },
        "prepare-1"
      )
    ).rejects.toThrow(/Prepare request must exactly match its authorization scope/);
  });

  it("refuses to build a preparation request whose inspected repository differs from the authorized one", async () => {
    const run = await seed();
    const state = openState(run);

    await expect(
      state.authorizePreparation(
        prepareInput(run) as never,
        { ...run.inspection, repositoryIdentity: "local-sha256:" + "a".repeat(64) },
        "prepare-1"
      )
    ).rejects.toThrow(/Prepare request must exactly match its authorization scope/);
  });

  it("binds a command start to the environment authorization recorded for its scope", async () => {
    const run = await seed();
    await prepared(run);
    const state = openState(run);

    const request = await state.authorizeStart(startInput(run) as never, "start-1");

    expect(request.commandId).toBe(run.commandId);
    expect(request.environmentAuthorizationId).toBe(run.environmentAuthorization.id);
    expect(request.environmentAuthorizationDigest).toBe(run.environmentAuthorization.digest);
    expect(request.authorization).toEqual(run.commandAuthorization);
    expect(request.idempotency).toEqual({ key: "start-1" });
  });

  it("rejects a command start whose command id does not match its authorization scope", async () => {
    const run = await seed();
    await prepared(run);
    const state = openState(run);

    await expect(
      state.authorizeStart(
        {
          ...startInput(run),
          commandId: createId("command", "123e4567-e89b-42d3-a456-4266141748aa")
        } as never,
        "start-1"
      )
    ).rejects.toThrow(/Command authorization is invalid/);
  });

  it("rejects a command start before the environment is prepared because the run is not implementing", async () => {
    const run = await seed();
    const state = openState(run);

    await expect(state.authorizeStart(startInput(run) as never, "start-1")).rejects.toThrow(
      /Command authorization rejected: run_state_mismatch/
    );
  });

  it("refuses to record a preparation intent for an authorization absent from the stream", async () => {
    const run = await seed();
    const state = openState(run);
    const request = await state.authorizePreparation(
      prepareInput(run) as never,
      run.inspection,
      "prepare-1"
    );
    const foreign = await seed({ seedOffset: 100, reuse: run });

    await expect(
      state.recordPreparationIntent({
        ...request,
        runId: foreign.runId,
        environmentId: foreign.environmentId
      } as never)
    ).rejects.toThrow(/Authorization must be durable before intent/);
  });
});

describe("EventBackedLocalExecutionState durable phases", () => {
  it("transitions the run to implementing when the prepared environment is recorded", async () => {
    const run = await seed();
    const { state } = await prepared(run);

    const pendingBefore = await state.listPendingPreparations();
    expect(pendingBefore).toHaveLength(0);
    await expect(state.authorizeStart(startInput(run) as never, "start-1")).resolves.toMatchObject({
      commandId: run.commandId
    });
  });

  it("treats a second prepared recording as a no-op instead of re-transitioning the run", async () => {
    const run = await seed();
    const { state, request } = await prepared(run);

    await expect(
      state.recordPrepared(request, preparedEnvironmentFor(run) as never)
    ).resolves.toBeUndefined();
    await expect(state.authorizeStart(startInput(run) as never, "start-1")).resolves.toBeDefined();
  });

  it("reports an unprepared environment as a pending preparation and drops it once prepared", async () => {
    const run = await seed();
    const state = openState(run);
    const request = await state.authorizePreparation(
      prepareInput(run) as never,
      run.inspection,
      "prepare-1"
    );
    await state.recordPreparationIntent(request);

    expect(await state.listPendingPreparations()).toEqual([request]);

    await state.recordPrepared(request, preparedEnvironmentFor(run) as never);
    expect(await state.listPendingPreparations()).toEqual([]);
  });

  it("reports an incomplete command as a pending start and drops it once completed", async () => {
    const run = await seed();
    const { state, start } = await started(run);

    expect(await state.listPendingCommandStarts()).toEqual([start]);

    await state.recordStarted({
      type: "command.started",
      runId: run.runId,
      commandId: run.commandId,
      sequence: 1,
      occurredAt: NOW
    } as never);
    await state.recordArtifact(transcript(run, `art_${"123e4567-e89b-42d3-a456-426614174321"}`), 2);
    await state.recordCompletion(completion(run));

    expect(await state.listPendingCommandStarts()).toEqual([]);
  });

  it("replays an identical phase without appending a duplicate event", async () => {
    const run = await seed();
    const { state, start } = await started(run);

    await expect(state.recordCommandIntent(start)).resolves.toBeUndefined();
    expect(await state.listPendingCommandStarts()).toEqual([start]);
  });

  it("rejects a phase whose key was already committed with different evidence", async () => {
    const run = await seed();
    const { state } = await started(run);
    await state.recordStarted({
      type: "command.started",
      runId: run.runId,
      commandId: run.commandId,
      sequence: 1,
      occurredAt: NOW
    } as never);

    await expect(
      state.recordStarted({
        type: "command.started",
        runId: run.runId,
        commandId: run.commandId,
        sequence: 7,
        occurredAt: NOW
      } as never)
    ).rejects.toThrow(/Local phase idempotency conflict/);
  });

  it("maps a non-zero exit code to a failed command result", async () => {
    const run = await seed();
    const { state } = await started(run);
    await state.recordStarted({
      type: "command.started",
      runId: run.runId,
      commandId: run.commandId,
      sequence: 1,
      occurredAt: NOW
    } as never);
    await state.recordArtifact(transcript(run, "art_123e4567-e89b-42d3-a456-426614174322"), 2);

    await state.recordCompletion(completion(run, { exitCode: 3 }));

    // The recorded status is only observable on the durable `command.completed` event, so read
    // it back rather than asserting a side effect that would also hold for a clean exit.
    const events = await run.store.readRunEvents({
      workspaceId: run.workspaceId,
      runId: run.runId,
      afterGlobalSequence: 0,
      limit: 100
    });
    const completed = events.filter((event) => event.type === "command.completed");

    expect(completed).toHaveLength(1);
    expect(completed[0]?.payload).toMatchObject({ commandId: run.commandId, status: "failed" });
  });

  it("records a transcript artifact and answers evidence queries about it", async () => {
    const run = await seed();
    const { state } = await started(run);
    const artifactId = "art_123e4567-e89b-42d3-a456-426614174323";
    await state.recordStarted({
      type: "command.started",
      runId: run.runId,
      commandId: run.commandId,
      sequence: 1,
      occurredAt: NOW
    } as never);

    expect(await state.hasArtifact(ArtifactIdSchema.parse(artifactId))).toBe(false);
    expect(await state.hasVerifiedTranscript(run.commandId)).toBe(false);

    await state.recordArtifact(transcript(run, artifactId), 2);

    expect(await state.hasArtifact(ArtifactIdSchema.parse(artifactId))).toBe(true);
    expect(await state.hasVerifiedTranscript(run.commandId)).toBe(true);
  });

  it("omits a zero host sequence from artifact evidence so the cursor stays at the durable floor", async () => {
    const run = await seed();
    const { state } = await started(run);
    await state.recordStarted({
      type: "command.started",
      runId: run.runId,
      commandId: run.commandId,
      sequence: 1,
      occurredAt: NOW
    } as never);
    await state.recordArtifact(transcript(run, "art_123e4567-e89b-42d3-a456-426614174324"), 0);

    const resolved = await state.resolveReconciliationEvents(run.environmentId, run.commandId);
    expect(resolved.after).toBe(1);
  });

  it("resumes reconciliation from the highest durable host sequence", async () => {
    const run = await seed();
    const { state } = await started(run);
    await state.recordStarted({
      type: "command.started",
      runId: run.runId,
      commandId: run.commandId,
      sequence: 1,
      occurredAt: NOW
    } as never);
    await state.recordArtifact(transcript(run, "art_123e4567-e89b-42d3-a456-426614174325"), 5);

    const resolved = await state.resolveReconciliationEvents(run.environmentId, run.commandId);
    expect(resolved.after).toBe(5);
    expect(resolved.commandAuthorizationId).toBe(run.commandAuthorization.id);
  });
});

describe("EventBackedLocalExecutionState ownership resolution", () => {
  it("resolves an events request carrying both authorization bindings from durable intent", async () => {
    const run = await seed();
    await started(run);
    const state = openState(run);

    const resolved = await state.resolveEvents({
      environmentId: run.environmentId,
      commandId: run.commandId,
      after: 3
    } as never);

    expect(resolved).toMatchObject({
      workspaceId: run.workspaceId,
      runId: run.runId,
      environmentId: run.environmentId,
      commandId: run.commandId,
      environmentAuthorizationId: run.environmentAuthorization.id,
      environmentAuthorizationDigest: run.environmentAuthorization.digest,
      commandAuthorizationId: run.commandAuthorization.id,
      commandAuthorizationDigest: run.commandAuthorization.digest,
      after: 3
    });
  });

  it("refuses to resolve a command claimed under the wrong environment", async () => {
    const run = await seed();
    await started(run);
    const other = await seed({ seedOffset: 200, reuse: run });
    const state = openState(run);

    await expect(
      state.resolveEvents({
        environmentId: other.environmentId,
        commandId: run.commandId,
        after: 0
      } as never)
    ).rejects.toThrow(/Command ownership differs/);
  });

  it("reports an unknown command as a missing local execution resource", async () => {
    const run = await seed();
    await started(run);
    const state = openState(run);

    await expect(
      state.resolveEvents({
        environmentId: run.environmentId,
        commandId: createId("command", "123e4567-e89b-42d3-a456-4266141747ff"),
        after: 0
      } as never)
    ).rejects.toThrow(/Local execution resource was not found/);
  });

  it("resolves a cancellation carrying both authorization bindings and the caller's idempotency key", async () => {
    const run = await seed();
    await started(run);
    const state = openState(run);

    const resolved = await state.resolveCancellation({
      environmentId: run.environmentId,
      commandId: run.commandId,
      commandAuthorizationId: run.commandAuthorization.id,
      idempotencyKey: "cancel-1"
    } as never);

    // The stream cursor is not part of a cancel request; it must never leak in from the
    // ownership resolution the cancellation shares with the events request.
    expect(resolved).not.toHaveProperty("after");
    expect(resolved).toMatchObject({
      workspaceId: run.workspaceId,
      runId: run.runId,
      environmentId: run.environmentId,
      commandId: run.commandId,
      environmentAuthorizationId: run.environmentAuthorization.id,
      environmentAuthorizationDigest: run.environmentAuthorization.digest,
      commandAuthorizationId: run.commandAuthorization.id,
      commandAuthorizationDigest: run.commandAuthorization.digest,
      idempotency: { key: "cancel-1" }
    });
  });

  it("refuses a cancellation presented under a command authorization that does not own the command", async () => {
    const run = await seed();
    await started(run);
    const other = await seed({ seedOffset: 300, reuse: run });
    const state = openState(run);

    await expect(
      state.resolveCancellation({
        environmentId: run.environmentId,
        commandId: run.commandId,
        commandAuthorizationId: other.commandAuthorization.id,
        idempotencyKey: "cancel-1"
      } as never)
    ).rejects.toThrow(/Command authorization does not own cancellation/);
  });

  it("resolves an artifact read with command ownership and without a stream cursor", async () => {
    const run = await seed();
    const { state } = await started(run);
    const artifactId = "art_123e4567-e89b-42d3-a456-426614174326";
    await state.recordStarted({
      type: "command.started",
      runId: run.runId,
      commandId: run.commandId,
      sequence: 1,
      occurredAt: NOW
    } as never);
    await state.recordArtifact(transcript(run, artifactId), 2);

    const resolved = await state.resolveArtifactRead({
      artifactId: ArtifactIdSchema.parse(artifactId),
      offset: 0,
      length: 16
    } as never);

    expect(resolved).not.toHaveProperty("after");
    expect(resolved).toMatchObject({
      artifactId,
      commandId: run.commandId,
      environmentId: run.environmentId,
      offset: 0,
      length: 16
    });
  });

  it("reports a missing artifact instead of resolving an unowned read", async () => {
    const run = await seed();
    await started(run);
    const state = openState(run);

    await expect(
      state.resolveArtifactRead({
        artifactId: ArtifactIdSchema.parse("art_123e4567-e89b-42d3-a456-4266141743ff"),
        offset: 0,
        length: 16
      } as never)
    ).rejects.toThrow(/Local execution resource was not found/);
    expect(
      await state.hasArtifact(ArtifactIdSchema.parse("art_123e4567-e89b-42d3-a456-4266141743ff"))
    ).toBe(false);
  });

  it("resolves the approved plan approval that authorized a preparation", async () => {
    const run = await seed();
    const state = openState(run);

    await expect(
      state.resolvePreparationApproval(
        run.runId,
        run.environmentId,
        run.environmentAuthorization.id
      )
    ).resolves.toBe(run.planApprovalId);
  });

  it("refuses a preparation approval lookup for an environment the authorization does not own", async () => {
    const run = await seed();
    const other = await seed({ seedOffset: 400, reuse: run });
    const state = openState(run);

    await expect(
      state.resolvePreparationApproval(
        run.runId,
        other.environmentId,
        run.environmentAuthorization.id
      )
    ).rejects.toThrow(/Environment authorization does not own preparation/);
  });

  it("resolves the approved permission approval that authorized a command", async () => {
    const run = await seed();
    const state = openState(run);

    await expect(
      state.resolveCommandApproval(
        run.runId,
        run.environmentId,
        run.commandId,
        run.commandAuthorization.id
      )
    ).resolves.toBe(run.commandApprovalId);
  });

  it("refuses a command approval lookup for a command the authorization does not own", async () => {
    const run = await seed();
    const other = await seed({ seedOffset: 500, reuse: run });
    const state = openState(run);

    await expect(
      state.resolveCommandApproval(
        run.runId,
        run.environmentId,
        other.commandId,
        run.commandAuthorization.id
      )
    ).rejects.toThrow(/Command authorization does not own start/);
  });
});

describe("EventBackedLocalExecutionState disposal evidence", () => {
  it("refuses disposal while the run has no terminal transition", async () => {
    const run = await seed();
    await prepared(run);
    const state = openState(run);

    await expect(
      state.resolveDisposal({
        environmentId: run.environmentId,
        environmentAuthorizationId: run.environmentAuthorization.id,
        idempotencyKey: "dispose-1"
      } as never)
    ).rejects.toThrow(/Terminal run evidence is missing/);
  });

  it("refuses disposal under an authorization that does not own the environment", async () => {
    const run = await seed();
    await prepared(run);
    const other = await seed({ seedOffset: 600, reuse: run });
    const state = openState(run);

    await expect(
      state.resolveDisposal({
        environmentId: run.environmentId,
        environmentAuthorizationId: other.environmentAuthorization.id,
        idempotencyKey: "dispose-1"
      } as never)
    ).rejects.toThrow(/Environment authorization does not own disposal/);
  });

  it("reports an unprepared environment as a missing local execution resource", async () => {
    const run = await seed();
    const state = openState(run);

    await expect(
      state.resolveDisposal({
        environmentId: run.environmentId,
        environmentAuthorizationId: run.environmentAuthorization.id,
        idempotencyKey: "dispose-1"
      } as never)
    ).rejects.toThrow(/Local execution resource was not found/);
  });
});
