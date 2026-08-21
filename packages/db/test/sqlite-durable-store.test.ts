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

const makeStore = async (
  requestedFilePath?: string,
  options: {
    readonly leaseTokens?: readonly string[];
    readonly sensitiveValues?: readonly string[];
  } = {}
) => {
  const filePath = requestedFilePath ?? (await temporaryDatabasePath());
  let eventNumber = 10;
  let leaseNumber = 0;
  const database = openDatabase({ filePath });
  const store = new SqliteDurableStore(database, {
    eventId: () =>
      EventIdSchema.parse(
        `evt_123e4567-e89b-42d3-a456-${String(426614174000 + eventNumber++).padStart(12, "0")}`
      ),
    leaseToken: () => {
      const token = options.leaseTokens?.[leaseNumber];
      leaseNumber += 1;
      return token ?? `lease-${leaseNumber}`;
    },
    now: () => NOW,
    ...(options.sensitiveValues === undefined ? {} : { sensitiveValues: options.sensitiveValues })
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
    ).rejects.toThrow();

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

  it.each([
    ["function", { value: () => undefined }],
    ["undefined", { value: undefined }],
    ["bigint", { value: 1n }],
    ["symbol", { value: Symbol("unsafe") }],
    ["NaN", { value: Number.NaN }],
    ["Infinity", { value: Number.POSITIVE_INFINITY }],
    ["credential", { value: "ghp_0123456789abcdefghijklmnop" }]
  ])("rejects %s in job payloads and rolls back atomically", async (_label, payload) => {
    const { database, store } = await makeStore();

    await expect(store.commit(initialCommit({ jobs: [job({ payload })] }))).rejects.toThrow();
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

  it("rejects cyclic and configured-secret job payloads", async () => {
    const configuredSecret = "configured-secret-0123456789abcdef";
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const first = await makeStore(undefined, { sensitiveValues: [configuredSecret] });
    await expect(
      first.store.commit(initialCommit({ jobs: [job({ payload: cyclic })] }))
    ).rejects.toThrow(/cyclic/i);
    await expect(
      first.store.commit(
        initialCommit({
          idempotency: { scope: "secret", key: "secret" },
          jobs: [job({ payload: { value: configuredSecret } })]
        })
      )
    ).rejects.toThrow();
    expect(first.database.connection.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual(
      { count: 0 }
    );
    await first.store.close();
  });

  it("validates stream identity and event workspace coherence before writing", async () => {
    const { database, store } = await makeStore();
    const decision = createRunDecision();
    const runAppend = decision.appends[1];
    if (runAppend === undefined) throw new Error("Expected run append.");

    await expect(
      store.commit(
        initialCommit({
          appends: [{ ...runAppend, stream: { kind: "run", id: createRunDecision().workItem.id } }],
          jobs: []
        })
      )
    ).rejects.toThrow();
    const wrongWorkspaceEvent = {
      ...runAppend.events[0],
      workspaceId: WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174099")
    } as (typeof runAppend.events)[number];
    await expect(
      store.commit(
        initialCommit({
          idempotency: { scope: "wrong-workspace", key: "request" },
          appends: [{ ...runAppend, events: [wrongWorkspaceEvent] }],
          jobs: []
        })
      )
    ).rejects.toThrow();
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({
      count: 0
    });
    await store.close();
  });

  it("runtime-validates job IDs, stage, handler, and timestamps", async () => {
    const { database, store } = await makeStore();
    const invalid = {
      ...job(),
      jobId: "not-a-job-id",
      workspaceId: "not-a-workspace-id",
      runId: "not-a-run-id",
      stage: "unknown",
      handler: "",
      createdAt: "not-a-timestamp"
    } as unknown as NewWorkflowJob;
    await expect(store.commit(initialCommit({ appends: [], jobs: [invalid] }))).rejects.toThrow();
    expect(
      database.connection.prepare("SELECT COUNT(*) AS count FROM workflow_jobs").get()
    ).toEqual({ count: 0 });
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

  it("retries colliding lease tokens until it obtains a unique active token", async () => {
    const { store } = await makeStore(undefined, {
      leaseTokens: ["collision", "collision", "unique-token"]
    });
    const secondJob = job({
      jobId: JobIdSchema.parse("job_123e4567-e89b-42d3-a456-426614174002")
    });
    await store.commit(initialCommit({ jobs: [job(), secondJob] }));

    const first = await store.leaseNext({ workerId: "worker-1", now: NOW, leaseDurationMs: 1_000 });
    const second = await store.leaseNext({
      workerId: "worker-2",
      now: NOW,
      leaseDurationMs: 1_000
    });
    expect(first?.leaseToken).toBe("collision");
    expect(second?.leaseToken).toBe("unique-token");
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
      error: {
        code: "temporary_error",
        name: "TemporaryError",
        message: "try again",
        retryable: true
      },
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
      error: {
        code: "temporary_error",
        name: "TemporaryError",
        message: "still failing",
        retryable: true
      },
      nextAvailableAt: TWO_SECONDS_LATER
    });

    expect(
      database.connection
        .prepare("SELECT status, last_error_json AS lastError FROM workflow_jobs WHERE job_id = ?")
        .get(job().jobId)
    ).toEqual({
      status: "failed",
      lastError: JSON.stringify({
        code: "temporary_error",
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
        error: {
          code: "temporary_error",
          name: "TemporaryError",
          message: "try again",
          retryable: true
        },
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

  it("rejects wrong and expired completion leases without partial output", async () => {
    const { database, store } = await makeStore();
    await store.commit(initialCommit());
    const leased = await store.leaseNext({
      workerId: "worker-1",
      now: NOW,
      leaseDurationMs: 1_000
    });
    if (leased === null) throw new Error("Expected a workflow lease.");
    const completion = {
      jobId: leased.jobId,
      now: NOW,
      idempotency: { scope: "test:wrong-complete", key: "request" },
      appends: [transitionAppend()],
      jobs: []
    } as const;

    await expect(store.completeJob({ ...completion, leaseToken: "wrong" })).rejects.toBeInstanceOf(
      LeaseConflictError
    );
    await expect(
      store.completeJob({
        ...completion,
        now: TWO_SECONDS_LATER,
        leaseToken: leased.leaseToken,
        idempotency: { scope: "test:expired-complete", key: "request" }
      })
    ).rejects.toBeInstanceOf(LeaseConflictError);
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({
      count: 2
    });
    expect(database.connection.prepare("SELECT status FROM workflow_jobs").get()).toEqual({
      status: "leased"
    });
    await store.close();
  });

  it("validates the active lease before returning an idempotent completion replay", async () => {
    const { store } = await makeStore();
    await store.commit(initialCommit());
    const leased = await store.leaseNext({
      workerId: "worker-1",
      now: NOW,
      leaseDurationMs: 10_000
    });
    if (leased === null) throw new Error("Expected a workflow lease.");
    const completion = {
      jobId: leased.jobId,
      now: ONE_SECOND_LATER,
      idempotency: { scope: "test:leased-replay", key: "request" },
      appends: [transitionAppend()],
      jobs: []
    } as const;
    await store.completeJob({ ...completion, leaseToken: leased.leaseToken });

    await expect(
      store.completeJob({ ...completion, leaseToken: "wrong-lease-token" })
    ).rejects.toBeInstanceOf(LeaseConflictError);
    await store.close();
  });

  it("replays an exact completed request only for its original job and lease", async () => {
    const { database, store } = await makeStore();
    await store.commit(initialCommit());
    const leased = await store.leaseNext({
      workerId: "worker-1",
      now: NOW,
      leaseDurationMs: 10_000
    });
    if (leased === null) throw new Error("Expected a workflow lease.");
    const completion = {
      jobId: leased.jobId,
      leaseToken: leased.leaseToken,
      now: ONE_SECOND_LATER,
      idempotency: { scope: "test:exact-completion-replay", key: "request" },
      appends: [transitionAppend()],
      jobs: []
    } as const;
    const first = await store.completeJob(completion);

    await expect(store.completeJob(completion)).resolves.toEqual({ ...first, replayed: true });
    await expect(store.completeJob({ ...completion, appends: [] })).rejects.toThrow(/bound/i);
    const binding = database.connection
      .prepare(
        `SELECT completion_lease_digest AS leaseDigest,
                completion_request_digest AS requestDigest
         FROM idempotency_records WHERE scope = ? AND key = ?`
      )
      .get(completion.idempotency.scope, completion.idempotency.key) as {
      leaseDigest: string;
      requestDigest: string;
    };
    expect(binding.leaseDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(binding.requestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(binding)).not.toContain(leased.leaseToken);
    await store.close();
  });

  it("rejects a generic idempotency record reused by an active job", async () => {
    const { database, store } = await makeStore();
    await store.commit({
      idempotency: { scope: "test:cross-operation", key: "request" },
      appends: [],
      jobs: []
    });
    await store.commit(initialCommit());
    const leased = await store.leaseNext({
      workerId: "worker-1",
      now: NOW,
      leaseDurationMs: 10_000
    });
    if (leased === null) throw new Error("Expected a workflow lease.");

    await expect(
      store.completeJob({
        jobId: leased.jobId,
        leaseToken: leased.leaseToken,
        now: ONE_SECOND_LATER,
        idempotency: { scope: "test:cross-operation", key: "request" },
        appends: [transitionAppend()],
        jobs: []
      })
    ).rejects.toThrow(/idempotency|bound/i);
    expect(database.connection.prepare("SELECT status FROM workflow_jobs").get()).toEqual({
      status: "leased"
    });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({
      count: 2
    });
    await store.close();
  });

  it("rejects coherent output appends outside the leased workspace and run atomically", async () => {
    const { database, store } = await makeStore();
    await store.commit(initialCommit());
    const leased = await store.leaseNext({
      workerId: "worker-1",
      now: NOW,
      leaseDurationMs: 10_000
    });
    if (leased === null) throw new Error("Expected a workflow lease.");
    const foreignWorkspaceId = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174099");
    const outputFor = (workspaceId: typeof WORKSPACE_ID, suffix: string) =>
      createManualRun(
        { title: "Foreign run" },
        {
          workspaceId,
          actor: { kind: "user", id: "foreign-user" },
          correlationId: `123e4567-e89b-42d3-a456-${suffix}`
        },
        {
          now: () => ONE_SECOND_LATER,
          ids: createIdFactory(() => `123e4567-e89b-42d3-a456-${suffix}`)
        }
      );
    const foreignWorkspace = outputFor(foreignWorkspaceId, "426614174099");
    const foreignRun = outputFor(WORKSPACE_ID, "426614174098");

    await expect(
      store.completeJob({
        jobId: leased.jobId,
        leaseToken: leased.leaseToken,
        now: ONE_SECOND_LATER,
        idempotency: { scope: "test:foreign-output", key: "request" },
        appends: foreignWorkspace.appends,
        jobs: []
      })
    ).rejects.toThrow(/leased workspace|leased run/i);
    await expect(
      store.completeJob({
        jobId: leased.jobId,
        leaseToken: leased.leaseToken,
        now: ONE_SECOND_LATER,
        idempotency: { scope: "test:foreign-run-output", key: "request" },
        appends: foreignRun.appends,
        jobs: []
      })
    ).rejects.toThrow(/leased workspace|leased run/i);
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({
      count: 2
    });
    expect(database.connection.prepare("SELECT status FROM workflow_jobs").get()).toEqual({
      status: "leased"
    });
    await store.close();
  });

  it("rejects wrong and expired failure leases without changing job state", async () => {
    const { database, store } = await makeStore();
    await store.commit(initialCommit());
    const leased = await store.leaseNext({
      workerId: "worker-1",
      now: NOW,
      leaseDurationMs: 1_000
    });
    if (leased === null) throw new Error("Expected a workflow lease.");
    const failure = {
      jobId: leased.jobId,
      error: { code: "workflow_handler_failed", name: "Error", message: "failed", retryable: false }
    } as const;
    await expect(
      store.failJob({ ...failure, leaseToken: "wrong", now: NOW })
    ).rejects.toBeInstanceOf(LeaseConflictError);
    await expect(
      store.failJob({ ...failure, leaseToken: leased.leaseToken, now: TWO_SECONDS_LATER })
    ).rejects.toBeInstanceOf(LeaseConflictError);
    expect(
      database.connection
        .prepare("SELECT status, last_error_json AS error FROM workflow_jobs")
        .get()
    ).toEqual({
      status: "leased",
      error: null
    });
    await store.close();
  });

  it("rejects child jobs outside the leased workspace and run atomically", async () => {
    const { database, store } = await makeStore();
    await store.commit(initialCommit());
    const leased = await store.leaseNext({
      workerId: "worker-1",
      now: NOW,
      leaseDurationMs: 10_000
    });
    if (leased === null) throw new Error("Expected a workflow lease.");
    const child = job({
      jobId: JobIdSchema.parse("job_123e4567-e89b-42d3-a456-426614174003"),
      workspaceId: WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174099")
    });
    await expect(
      store.completeJob({
        jobId: leased.jobId,
        leaseToken: leased.leaseToken,
        now: ONE_SECOND_LATER,
        idempotency: { scope: "test:foreign-child", key: "request" },
        appends: [transitionAppend()],
        jobs: [child]
      })
    ).rejects.toThrow(/workspace|run/i);
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({
      count: 2
    });
    expect(database.connection.prepare("SELECT status FROM workflow_jobs").get()).toEqual({
      status: "leased"
    });
    await store.close();
  });
});
