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
        recoverRunningTasks: async () => {},
        pruneTerminalTasks: async () => 0,
      },
    });

    await assert.rejects(
      service.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 100 },
        instructionId: "nope-not-a-real-strategy",
        agent: "claude",
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
          agent: input.agent,
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
        recoverRunningTasks: async () => {},
        pruneTerminalTasks: async () => 0,
      },
    });

    const task = await service.enqueue({
      repo: { owner: "octo", name: "repo" },
      source: { kind: "issue", number: 100 },
      instructionId: "issue-implement",
      agent: "claude",
      requestedBy: "test",
    });

    assert.equal(task.taskId, "task_1");
    assert.equal(task.status, "queued");
    assert.equal(task.agent, "claude");
    assert.equal(task.instructionId, "issue-implement");
  });
});
