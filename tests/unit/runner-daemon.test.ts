import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { InstructionDefinition } from "../../src/domain/instruction.js";
import type { TaskRecord } from "../../src/domain/task.js";
import { RunnerDaemon } from "../../src/daemon/runner-daemon.js";
import { SchedulerService } from "../../src/services/scheduler-service.js";

const instruction: InstructionDefinition = {
  id: "issue-comment-reply",
  revision: 1,
  sourceKind: "issue",
  mode: "observe",
  workflow: "observe",
  context: {},
  permissions: {
    codeRead: true,
    codeWrite: false,
    gitPush: false,
    prCreate: false,
    prUpdate: false,
    commentWrite: true,
  },
  githubActions: ["issue_comment"],
  execution: {
    timeoutSec: 1800,
  },
};

function createTask(status: TaskRecord["status"]): TaskRecord {
  return {
    taskId: "task_1",
    repo: { owner: "octo", name: "repo" },
    source: { kind: "issue", number: 100 },
    instructionId: "issue-comment-reply",
    agent: "claude",
    status,
    priority: "normal",
    requestedBy: "test",
    createdAt: "2026-04-24T00:00:00.000Z",
  };
}

describe("RunnerDaemon", () => {
  test("initializes recovery and processes one queued task", async () => {
    const calls: string[] = [];
    let currentTask = createTask("queued");

    const daemon = new RunnerDaemon({
      queueStore: {
        enqueue: async () => currentTask,
        listTasks: async () => [currentTask],
        getTask: async () => currentTask,
        startTask: async (taskId, instructionRevision) => {
          calls.push(`start:${taskId}:${instructionRevision}`);
          currentTask = {
            ...currentTask,
            status: "running",
            instructionRevision,
            startedAt: "2026-04-24T00:01:00.000Z",
          };
          return currentTask;
        },
        completeTask: async (taskId, input) => {
          calls.push(`complete:${taskId}:${input.status}`);
          currentTask = {
            ...currentTask,
            status: input.status,
            finishedAt: "2026-04-24T00:02:00.000Z",
            ...(input.errorSummary !== undefined
              ? { errorSummary: input.errorSummary }
              : {}),
          };
          return currentTask;
        },
        revertToQueued: async (taskId) => {
          calls.push(`revert:${taskId}`);
          return currentTask;
        },
        recoverRunningTasks: async (message) => {
          calls.push(`recover:${message}`);
        },
      },
      instructionLoader: {
        loadById: async () => instruction,
      },
      schedulerService: new SchedulerService({ maxConcurrency: 2 }),
      executionService: {
        execute: async () => {
          calls.push("execute");
          return { status: "succeeded" };
        },
      },
      logStore: {
        write: async () => {},
        cleanupExpired: async () => {
          calls.push("cleanupLogs");
        },
      },
      pollIntervalMs: 10,
    });

    await daemon.initialize();
    await daemon.tick();
    await daemon.waitForIdle();

    assert.deepEqual(calls, [
      "recover:daemon interrupted before completion",
      "cleanupLogs",
      "start:task_1:1",
      "execute",
      "complete:task_1:succeeded",
    ]);
  });

  test("reverts to queued and pauses the agent when execution returns a rate_limited result", async () => {
    const calls: string[] = [];
    let currentTask = createTask("queued");
    const pauses: Array<{ agent: string; pausedUntil: number }> = [];

    const daemon = new RunnerDaemon({
      queueStore: {
        enqueue: async () => currentTask,
        listTasks: async () => [currentTask],
        getTask: async () => currentTask,
        startTask: async (taskId, instructionRevision) => {
          calls.push(`start:${taskId}:${instructionRevision}`);
          currentTask = {
            ...currentTask,
            status: "running",
            instructionRevision,
            startedAt: "2026-04-26T00:01:00.000Z",
          };
          return currentTask;
        },
        completeTask: async () => {
          throw new Error("completeTask should not be called for rate-limited tasks");
        },
        revertToQueued: async (taskId) => {
          calls.push(`revert:${taskId}`);
          return currentTask;
        },
        recoverRunningTasks: async () => {},
      },
      instructionLoader: {
        loadById: async () => instruction,
      },
      schedulerService: new SchedulerService({ maxConcurrency: 2 }),
      executionService: {
        execute: async () => {
          calls.push("execute");
          return { status: "rate_limited", agentName: "claude" };
        },
      },
      logStore: {
        write: async (taskId, message) => {
          calls.push(`log:${taskId}:${message}`);
        },
        cleanupExpired: async () => {},
      },
      pollIntervalMs: 10,
      rateLimitStateStore: {
        loadActivePauses: async () => new Map(),
        pause: async (agent, pausedUntil) => {
          pauses.push({ agent, pausedUntil });
        },
      },
      rateLimitCooldownMs: 60_000,
      now: () => 5_000_000,
    });

    await daemon.tick();
    await daemon.waitForIdle();

    assert.deepEqual(pauses, [
      { agent: "claude", pausedUntil: 5_060_000 },
    ]);
    assert.ok(calls.includes("revert:task_1"));
    assert.ok(calls.some((c) => c.startsWith("log:task_1:rate-limited")));
  });

  test("notifies task failure when execution throws a non rate-limit error", async () => {
    const notified: Array<{ taskId: string; errorSummary: string }> = [];
    let currentTask = createTask("queued");

    const daemon = new RunnerDaemon({
      queueStore: {
        enqueue: async () => currentTask,
        listTasks: async () => [currentTask],
        getTask: async () => currentTask,
        startTask: async (_taskId, instructionRevision) => {
          currentTask = {
            ...currentTask,
            status: "running",
            instructionRevision,
            startedAt: "2026-04-27T00:01:00.000Z",
          };
          return currentTask;
        },
        completeTask: async (_taskId, input) => {
          currentTask = {
            ...currentTask,
            status: input.status,
            ...(input.errorSummary !== undefined
              ? { errorSummary: input.errorSummary }
              : {}),
          };
          return currentTask;
        },
        revertToQueued: async () => currentTask,
        recoverRunningTasks: async () => {},
      },
      instructionLoader: {
        loadById: async () => instruction,
      },
      schedulerService: new SchedulerService({ maxConcurrency: 2 }),
      executionService: {
        execute: async () => {
          throw new Error("getSourceContext network failure");
        },
      },
      logStore: {
        write: async () => {},
        cleanupExpired: async () => {},
      },
      pollIntervalMs: 10,
      notifyTaskFailure: async (task, errorSummary) => {
        notified.push({ taskId: task.taskId, errorSummary });
      },
    });

    await daemon.tick();
    await daemon.waitForIdle();

    assert.equal(notified.length, 1);
    assert.equal(notified[0]?.taskId, "task_1");
    assert.match(notified[0]?.errorSummary ?? "", /getSourceContext/);
  });

  test("does not notify task failure on a rate_limited result", async () => {
    const notified: string[] = [];
    let currentTask = createTask("queued");

    const daemon = new RunnerDaemon({
      queueStore: {
        enqueue: async () => currentTask,
        listTasks: async () => [currentTask],
        getTask: async () => currentTask,
        startTask: async (_taskId, instructionRevision) => {
          currentTask = {
            ...currentTask,
            status: "running",
            instructionRevision,
            startedAt: "2026-04-27T00:01:00.000Z",
          };
          return currentTask;
        },
        completeTask: async () => {
          throw new Error("completeTask should not run for rate-limited tasks");
        },
        revertToQueued: async () => currentTask,
        recoverRunningTasks: async () => {},
      },
      instructionLoader: {
        loadById: async () => instruction,
      },
      schedulerService: new SchedulerService({ maxConcurrency: 2 }),
      executionService: {
        execute: async () => ({ status: "rate_limited", agentName: "claude" }),
      },
      logStore: {
        write: async () => {},
        cleanupExpired: async () => {},
      },
      pollIntervalMs: 10,
      notifyTaskFailure: async (task) => {
        notified.push(task.taskId);
      },
    });

    await daemon.tick();
    await daemon.waitForIdle();

    assert.equal(notified.length, 0);
  });

  test("daemon survives when notifyTaskFailure throws", async () => {
    const warnings: string[] = [];
    let currentTask = createTask("queued");

    const daemon = new RunnerDaemon({
      queueStore: {
        enqueue: async () => currentTask,
        listTasks: async () => [currentTask],
        getTask: async () => currentTask,
        startTask: async (_taskId, instructionRevision) => {
          currentTask = {
            ...currentTask,
            status: "running",
            instructionRevision,
            startedAt: "2026-04-27T00:01:00.000Z",
          };
          return currentTask;
        },
        completeTask: async (_taskId, input) => {
          currentTask = {
            ...currentTask,
            status: input.status,
            ...(input.errorSummary !== undefined
              ? { errorSummary: input.errorSummary }
              : {}),
          };
          return currentTask;
        },
        revertToQueued: async () => currentTask,
        recoverRunningTasks: async () => {},
      },
      instructionLoader: {
        loadById: async () => instruction,
      },
      schedulerService: new SchedulerService({ maxConcurrency: 2 }),
      executionService: {
        execute: async () => ({
          status: "failed",
          errorSummary: "boom",
        }),
      },
      logStore: {
        write: async () => {},
        cleanupExpired: async () => {},
      },
      pollIntervalMs: 10,
      warn: (message) => warnings.push(message),
      notifyTaskFailure: async () => {
        throw new Error("notify failed");
      },
    });

    await daemon.tick();
    await daemon.waitForIdle();

    assert.equal(currentTask.status, "failed");
    assert.ok(
      warnings.some((message) => message.includes("notifyTaskFailure threw")),
      `expected a warning about notifyTaskFailure, got: ${warnings.join(", ")}`,
    );
  });
});
