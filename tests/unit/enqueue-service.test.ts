import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EnqueueService } from "../../src/services/enqueue-service.js";

describe("EnqueueService", () => {
  test("rejects an instructionId with no registered strategy", async () => {
    const service = new EnqueueService({
      queueStore: {
        enqueue: async () => {
          throw new Error("should not be called");
        },
        listTasks: async () => [],
        getTask: async () => undefined,
        startTask: async () => {
          throw new Error("should not be called");
        },
        completeTask: async () => {
          throw new Error("should not be called");
        },
        revertToQueued: async () => {
          throw new Error("should not be called");
        },
        findQueuedBySource: async () => [],
        markSuperseded: async () => {
          throw new Error("markSuperseded not exercised in this test");
        },
        recoverRunningTasks: async () => {},
        pruneTerminalTasks: async () => 0,
      },
    });

    await assert.rejects(
      service.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 100 },
        instructionId: "nope-not-a-real-strategy",
        requestedBy: "test",
      }),
      /no strategy is registered/i,
    );
  });

  test("enqueues a task for a known strategy id", async () => {
    const service = new EnqueueService({
      queueStore: {
        enqueue: async (input) => ({
          taskId: "task_1",
          repo: input.repo,
          source: input.source,
          instructionId: input.instructionId,
          status: "queued",
          priority: input.priority ?? "normal",
          requestedBy: input.requestedBy,
          createdAt: "2026-04-24T00:00:00.000Z",
        }),
        listTasks: async () => [],
        getTask: async () => undefined,
        startTask: async () => {
          throw new Error("should not be called");
        },
        completeTask: async () => {
          throw new Error("should not be called");
        },
        revertToQueued: async () => {
          throw new Error("should not be called");
        },
        findQueuedBySource: async () => [],
        markSuperseded: async () => {
          throw new Error("markSuperseded not exercised in this test");
        },
        recoverRunningTasks: async () => {},
        pruneTerminalTasks: async () => 0,
      },
    });

    const task = await service.enqueue({
      repo: { owner: "octo", name: "repo" },
      source: { kind: "issue", number: 100 },
      instructionId: "issue-implement",
      requestedBy: "test",
    });

    assert.equal(task.taskId, "task_1");
    assert.equal(task.status, "queued");
    assert.equal(task.instructionId, "issue-implement");
  });

  test("supersedes a prior active task on the same (repo, source)", async () => {
    const supersedeCalls: Array<{ oldId: string; newId: string }> = [];

    const old = {
      taskId: "task_old",
      repo: { owner: "octo", name: "repo" },
      source: { kind: "issue" as const, number: 100 },
      instructionId: "issue-implement",
      status: "queued" as const,
      priority: "normal" as const,
      requestedBy: "alice",
      createdAt: "2026-04-30T00:00:00.000Z",
    };

    const service = new EnqueueService({
      queueStore: {
        enqueue: async (input) => ({
          taskId: "task_new",
          repo: input.repo,
          source: input.source,
          instructionId: input.instructionId,
          status: "queued",
          priority: "normal",
          requestedBy: input.requestedBy,
          createdAt: "2026-04-30T01:00:00.000Z",
        }),
        listTasks: async () => [],
        getTask: async () => undefined,
        startTask: async () => {
          throw new Error("should not be called");
        },
        completeTask: async () => {
          throw new Error("should not be called");
        },
        revertToQueued: async () => {
          throw new Error("should not be called");
        },
        findQueuedBySource: async () => [old],
        markSuperseded: async (oldId, newId) => {
          supersedeCalls.push({ oldId, newId });
          return { ...old, status: "superseded", supersededBy: newId };
        },
        recoverRunningTasks: async () => {},
        pruneTerminalTasks: async () => 0,
      },
    });

    const newTask = await service.enqueue({
      repo: { owner: "octo", name: "repo" },
      source: { kind: "issue", number: 100 },
      instructionId: "issue-implement",
      requestedBy: "alice",
    });

    assert.equal(newTask.taskId, "task_new");
    assert.deepEqual(supersedeCalls, [
      { oldId: "task_old", newId: "task_new" },
    ]);
  });

  test("does not supersede when only a running task exists on the same source", async () => {
    // findQueuedBySource is the seam that filters out running tasks. The
    // service must trust that contract: when no queued conflicts come back,
    // the new task simply lands without firing markSuperseded or the
    // onSupersede hook — the running task on the same source runs to
    // completion.
    const supersedeCalls: Array<{ oldId: string; newId: string }> = [];
    const onSupersedeCalls: Array<{ oldId: string; newId: string }> = [];

    const service = new EnqueueService({
      queueStore: {
        enqueue: async (input) => ({
          taskId: "task_new",
          repo: input.repo,
          source: input.source,
          instructionId: input.instructionId,
          status: "queued",
          priority: "normal",
          requestedBy: input.requestedBy,
          createdAt: "2026-05-05T00:00:00.000Z",
        }),
        listTasks: async () => [],
        getTask: async () => undefined,
        startTask: async () => {
          throw new Error("should not be called");
        },
        completeTask: async () => {
          throw new Error("should not be called");
        },
        revertToQueued: async () => {
          throw new Error("should not be called");
        },
        // No queued conflict — running tasks on the same source are
        // intentionally excluded by the store contract.
        findQueuedBySource: async () => [],
        markSuperseded: async (oldId, newId) => {
          supersedeCalls.push({ oldId, newId });
          throw new Error("markSuperseded must not be called");
        },
        recoverRunningTasks: async () => {},
        pruneTerminalTasks: async () => 0,
      },
      onSupersede: async (oldId, newId) => {
        onSupersedeCalls.push({ oldId, newId });
      },
    });

    const newTask = await service.enqueue({
      repo: { owner: "octo", name: "repo" },
      source: { kind: "issue", number: 100 },
      instructionId: "issue-implement",
      requestedBy: "alice",
    });

    assert.equal(newTask.taskId, "task_new");
    assert.deepEqual(supersedeCalls, []);
    assert.deepEqual(onSupersedeCalls, []);
  });
});
