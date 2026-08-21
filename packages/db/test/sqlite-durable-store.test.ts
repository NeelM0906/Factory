import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EventIdSchema,
  JobIdSchema,
  PendingDomainEventSchema,
  WorkspaceIdSchema,
  createIdFactory
} from "@autostack/contracts";
import {
  LeaseConflictError,
  OptimisticConcurrencyError,
  createManualRun,
  type CommitRequest,
  type NewWorkflowJob,
  type StreamAppend
} from "@autostack/domain";

import { SqliteDurableStore, openDatabase } from "../src/index.js";

const NOW = "2026-08-20T12:00:00.000Z";
const ONE_SECOND_LATER = "2026-08-20T12:00:01.000Z";
const TWO_SECONDS_LATER = "2026-08-20T12:00:02.000Z";
const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174000");
const temporaryDirectories: string[] = [];

const temporaryDatabasePath = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "autostack-store-"));
  temporaryDirectories.push(directory);
  return join(directory, "autostack.sqlite");
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const makeStore = async (requestedFilePath?: string) => {
  const filePath = requestedFilePath ?? (await temporaryDatabasePath());
  let eventNumber = 10;
  let leaseNumber = 0;
  const database = openDatabase({ filePath });
  const store = new SqliteDurableStore(database, {
    eventId: () =>
      EventIdSchema.parse(
        `evt_123e4567-e89b-42d3-a456-${String(426614174000 + eventNumber++).padStart(12, "0")}`
      ),
    leaseToken: () => `lease-${++leaseNumber}`,
    now: () => NOW
  });
  return { database, store, filePath };
};

const createRunDecision = () =>
  createManualRun(
    { title: "Persist an AutoStack run" },
    {
      workspaceId: WORKSPACE_ID,
      actor: { kind: "user", id: "local-user" },
      correlationId: "123e4567-e89b-42d3-a456-426614174001"
    },
    {
      now: () => NOW,
      ids: createIdFactory(() => "123e4567-e89b-42d3-a456-426614174000")
    }
  );

const job = (overrides: Partial<NewWorkflowJob> = {}): NewWorkflowJob => ({
  jobId: JobIdSchema.parse("job_123e4567-e89b-42d3-a456-426614174000"),
  workspaceId: WORKSPACE_ID,
  runId: createRunDecision().run.id,
  stage: "triage",
  handler: "test.triage",
  payload: { task: "triage" },
  maxAttempts: 2,
  availableAt: NOW,
  createdAt: NOW,
  ...overrides
});

const initialCommit = (overrides: Partial<CommitRequest> = {}): CommitRequest => {
  const decision = createRunDecision();
  return {
    idempotency: { scope: "test:create-run", key: "request-1" },
    appends: decision.appends,
    jobs: [job()],
    ...overrides
  };
};

const transitionAppend = (): StreamAppend => {
  const decision = createRunDecision();
  return {
    stream: { kind: "run", id: decision.run.id },
    expectedVersion: 1,
    events: [
      PendingDomainEventSchema.parse({
        workspaceId: WORKSPACE_ID,
        actor: { kind: "system", id: "autostack" },
        correlationId: "123e4567-e89b-42d3-a456-426614174001",
        occurredAt: ONE_SECOND_LATER,
        type: "run.transitioned",
        payload: {
          runId: decision.run.id,
          from: "queued",
          to: "triaging",
          reason: "triage started"
        }
      })
    ]
  };
};

describe("SQLite durable commits", () => {
  it("atomically appends two streams and enqueues a job", async () => {
    const { database, store } = await makeStore();

    const result = await store.commit(initialCommit());

    expect(result.replayed).toBe(false);
    expect(result.events.map(({ globalSequence }) => globalSequence)).toEqual([1, 2]);
    expect(result.events.map(({ streamVersion }) => streamVersion)).toEqual([1, 1]);
    expect(result.jobIds).toEqual([job().jobId]);
    expect(
      database.connection.prepare("SELECT COUNT(*) AS count FROM workflow_jobs").get()
    ).toEqual({
      count: 1
    });
    await store.close();
  });

  it("returns the original result without duplicate events or jobs on replay", async () => {
    const { database, store } = await makeStore();
    const first = await store.commit(initialCommit());
    const replay = await store.commit(initialCommit());

    expect(replay).toEqual({ ...first, replayed: true });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({
      count: 2
    });
    expect(
      database.connection.prepare("SELECT COUNT(*) AS count FROM workflow_jobs").get()
    ).toEqual({
      count: 1
    });
    await store.close();
  });

  it("rejects a stale expected stream version", async () => {
    const { store } = await makeStore();
    await store.commit(initialCommit());

    await expect(
      store.commit({
        idempotency: { scope: "test:transition", key: "wrong-version" },
        appends: [{ ...transitionAppend(), expectedVersion: 0 }],
        jobs: []
      })
    ).rejects.toBeInstanceOf(OptimisticConcurrencyError);
    await store.close();
  });

  it("timestamps a jobs-only idempotency record with the injected clock", async () => {
    const { database, store } = await makeStore();

    await store.commit({
      idempotency: { scope: "test:jobs", key: "jobs-only" },
      appends: [],
      jobs: [job()]
    });

    expect(
      database.connection
        .prepare(
          "SELECT created_at AS createdAt FROM idempotency_records WHERE scope = ? AND key = ?"
        )
        .get("test:jobs", "jobs-only")
    ).toEqual({ createdAt: NOW });
    await store.close();
  });

  it("rolls back events when a queued job has an invalid timestamp", async () => {
    const { database, store } = await makeStore();

    await expect(
      store.commit(initialCommit({ jobs: [job({ availableAt: "not-a-timestamp" })] }))
    ).rejects.toThrow(TypeError);

    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({
      count: 0
    });
    expect(
      database.connection.prepare("SELECT COUNT(*) AS count FROM workflow_jobs").get()
    ).toEqual({
      count: 0
    });
    await store.close();
  });

  it("reads streams and global events from exclusive cursors", async () => {
    const { store } = await makeStore();
    await store.commit(initialCommit());
    await store.commit({
      idempotency: { scope: "test:transition", key: "transition-1" },
      appends: [transitionAppend()],
      jobs: []
    });

    const streamEvents = await store.readStream({
      stream: transitionAppend().stream,
      afterVersion: 1
    });
    const globalEvents = await store.readAll({
      afterGlobalSequence: 1,
      workspaceId: WORKSPACE_ID,
      limit: 1
    });

    expect(streamEvents.map(({ streamVersion }) => streamVersion)).toEqual([2]);
    expect(globalEvents.map(({ globalSequence }) => globalSequence)).toEqual([2]);
    await store.close();
  });

  it("persists events across close and reopen", async () => {
    const first = await makeStore();
    await first.store.commit(initialCommit());
    await first.store.close();

    const second = await makeStore(first.filePath);
    const events = await second.store.readAll({});

    expect(events).toHaveLength(2);
    expect(events.map(({ globalSequence }) => globalSequence)).toEqual([1, 2]);
    await second.store.close();
  });
});

describe("SQLite workflow leases", () => {
  it("does not lease future work", async () => {
    const { store } = await makeStore();
    await store.commit(initialCommit({ jobs: [job({ availableAt: TWO_SECONDS_LATER })] }));

    expect(
      await store.leaseNext({ workerId: "worker-1", now: NOW, leaseDurationMs: 1_000 })
    ).toBeNull();
    await store.close();
  });

  it("leases FIFO work and heartbeats only with the active token", async () => {
    const { database, store } = await makeStore();
    const secondJob = job({
      jobId: JobIdSchema.parse("job_123e4567-e89b-42d3-a456-426614174002"),
      createdAt: ONE_SECOND_LATER
    });
    await store.commit(initialCommit({ jobs: [job(), secondJob] }));

    const leased = await store.leaseNext({
      workerId: "worker-1",
      now: NOW,
      leaseDurationMs: 1_000
    });

    expect(leased).toMatchObject({ jobId: job().jobId, attempt: 1, leaseToken: "lease-1" });
    await expect(
      store.heartbeat({
        jobId: job().jobId,
        leaseToken: "wrong-token",
        now: NOW,
        leaseDurationMs: 2_000
      })
    ).rejects.toBeInstanceOf(LeaseConflictError);
    await store.heartbeat({
      jobId: job().jobId,
      leaseToken: "lease-1",
      now: NOW,
      leaseDurationMs: 2_000
    });
    expect(
      database.connection
        .prepare("SELECT lease_expires_at AS leaseExpiresAt FROM workflow_jobs WHERE job_id = ?")
        .get(job().jobId)
    ).toEqual({ leaseExpiresAt: TWO_SECONDS_LATER });
    await store.close();
  });

  it("recovers an expired lease with a new token and incremented attempt", async () => {
    const { store } = await makeStore();
    await store.commit(initialCommit());
    await store.leaseNext({ workerId: "worker-1", now: NOW, leaseDurationMs: 1_000 });

    const recovered = await store.leaseNext({
      workerId: "worker-2",
      now: TWO_SECONDS_LATER,
      leaseDurationMs: 1_000
    });

    expect(recovered).toMatchObject({ attempt: 2, leaseOwner: "worker-2", leaseToken: "lease-2" });
    await store.close();
  });

  it("completes a leased job with output events and next work atomically", async () => {
    const { database, store } = await makeStore();
    await store.commit(initialCommit());
    const leased = await store.leaseNext({
      workerId: "worker-1",
      now: NOW,
      leaseDurationMs: 10_000
    });
    expect(leased).not.toBeNull();
    if (leased === null) throw new Error("Expected the initial workflow job to be leased.");
    const nextJob = job({
      jobId: JobIdSchema.parse("job_123e4567-e89b-42d3-a456-426614174003"),
      stage: "plan",
      handler: "test.plan"
    });

    const result = await store.completeJob({
      jobId: job().jobId,
      leaseToken: leased.leaseToken,
      now: ONE_SECOND_LATER,
      idempotency: { scope: "test:complete", key: job().jobId },
      appends: [transitionAppend()],
      jobs: [nextJob]
    });

    expect(result.events).toHaveLength(1);
    expect(await store.readStream({ stream: transitionAppend().stream })).toHaveLength(2);
    expect(
      database.connection
        .prepare("SELECT status FROM workflow_jobs WHERE job_id = ?")
        .get(job().jobId)
    ).toEqual({
      status: "completed"
    });
    expect(
      database.connection.prepare("SELECT COUNT(*) AS count FROM workflow_jobs").get()
    ).toEqual({
      count: 2
    });
    await store.close();
  });

  it("requeues retryable failure below the attempt limit and fails at the limit", async () => {
    const { database, store } = await makeStore();
    await store.commit(initialCommit());
    const firstLease = await store.leaseNext({
      workerId: "worker-1",
      now: NOW,
      leaseDurationMs: 1_000
    });
    if (firstLease === null) throw new Error("Expected the first workflow lease.");
    await store.failJob({
      jobId: job().jobId,
      leaseToken: firstLease.leaseToken,
      now: NOW,
      error: { name: "TemporaryError", message: "try again", retryable: true },
      nextAvailableAt: ONE_SECOND_LATER
    });
    expect(
      database.connection
        .prepare("SELECT status FROM workflow_jobs WHERE job_id = ?")
        .get(job().jobId)
    ).toEqual({
      status: "queued"
    });

    const secondLease = await store.leaseNext({
      workerId: "worker-2",
      now: ONE_SECOND_LATER,
      leaseDurationMs: 1_000
    });
    if (secondLease === null) throw new Error("Expected the retry workflow lease.");
    await store.failJob({
      jobId: job().jobId,
      leaseToken: secondLease.leaseToken,
      now: ONE_SECOND_LATER,
      error: { name: "TemporaryError", message: "still failing", retryable: true },
      nextAvailableAt: TWO_SECONDS_LATER
    });

    expect(
      database.connection
        .prepare("SELECT status, last_error_json AS lastError FROM workflow_jobs WHERE job_id = ?")
        .get(job().jobId)
    ).toEqual({
      status: "failed",
      lastError: JSON.stringify({
        name: "TemporaryError",
        message: "still failing",
        retryable: true
      })
    });
    await store.close();
  });

  it("rejects an invalid retry timestamp without releasing the active lease", async () => {
    const { database, store } = await makeStore();
    await store.commit(initialCommit());
    const leased = await store.leaseNext({
      workerId: "worker-1",
      now: NOW,
      leaseDurationMs: 1_000
    });
    if (leased === null) throw new Error("Expected a workflow lease.");

    await expect(
      store.failJob({
        jobId: job().jobId,
        leaseToken: leased.leaseToken,
        now: NOW,
        error: { name: "TemporaryError", message: "try again", retryable: true },
        nextAvailableAt: "not-a-timestamp"
      })
    ).rejects.toThrow(TypeError);

    expect(
      database.connection
        .prepare("SELECT status FROM workflow_jobs WHERE job_id = ?")
        .get(job().jobId)
    ).toEqual({
      status: "leased"
    });
    await store.close();
  });
});
