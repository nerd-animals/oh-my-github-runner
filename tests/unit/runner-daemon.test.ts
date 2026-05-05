import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TaskRecord } from "../../src/domain/task.js";
import { RunnerDaemon } from "../../src/daemon/runner-daemon.js";
import { SchedulerService } from "../../src/services/scheduler-service.js";

function createTask(status: TaskRecord["status"]): TaskRecord {
  return {
    taskId: "task_1",
    repo: { owner: "octo", name: "repo" },
    source: { kind: "issue", number: 100 },
    instructionId: "issue-comment-reply",
    status,
    priority: "normal",
    requestedBy: "test",
    createdAt: "2026-04-24T00:00:00.000Z",
  };
}

const stubToolsForTask = (): readonly string[] => ["claude"];

describe("RunnerDaemon", () => {
  test("initializes recovery and processes one queued task", async () => {
    const calls: string[] = [];
    let currentTask = createTask("queued");

    const daemon = new RunnerDaemon({
      queueStore: {
        enqueue: async () => currentTask,
        listTasks: async () => [currentTask],
        getTask: async () => currentTask,
        startTask: async (taskId) => {
          calls.push(`start:${taskId}`);
          currentTask = {
            ...currentTask,
            status: "running",
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
        findActiveBySource: async () => [],
        markSuperseded: async () => {
          throw new Error("markSuperseded not exercised in this test");
        },
        recoverRunningTasks: async (message) => {
          calls.push(`recover:${message}`);
        },
        pruneTerminalTasks: async () => 0,
      },
      schedulerService: new SchedulerService({ maxConcurrency: 2 }),
      toolsForTask: stubToolsForTask,
      runStrategy: async () => {
        calls.push("execute");
        return { status: "succeeded" };
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
      "start:task_1",
      "execute",
      "complete:task_1:succeeded",
    ]);
  });

  test("reverts to queued and pauses the tool when execution returns a rate_limited result", async () => {
    const calls: string[] = [];
    let currentTask = createTask("queued");
    const pauses: Array<{ tool: string; pausedUntil: number }> = [];

    const daemon = new RunnerDaemon({
      queueStore: {
        enqueue: async () => currentTask,
        listTasks: async () => [currentTask],
        getTask: async () => currentTask,
        startTask: async (taskId) => {
          calls.push(`start:${taskId}`);
          currentTask = {
            ...currentTask,
            status: "running",
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
        findActiveBySource: async () => [],
        markSuperseded: async () => {
          throw new Error("markSuperseded not exercised in this test");
        },
        recoverRunningTasks: async () => {},
        pruneTerminalTasks: async () => 0,
      },
      schedulerService: new SchedulerService({ maxConcurrency: 2 }),
      toolsForTask: stubToolsForTask,
      runStrategy: async () => {
        calls.push("execute");
        return { status: "rate_limited", toolName: "claude" };
      },
      logStore: {
        write: async (taskId, message) => {
          calls.push(`log:${taskId}:${message}`);
        },
        cleanupExpired: async () => {},
      },
      pollIntervalMs: 10,
      rateLimit: {
        store: {
          loadActivePauses: async () => new Map(),
          pause: async (tool, pausedUntil) => {
            pauses.push({ tool, pausedUntil });
          },
        },
        cooldownMs: 60_000,
      },
      clock: { now: () => 5_000_000 },
    });

    await daemon.tick();
    await daemon.waitForIdle();

    assert.deepEqual(pauses, [
      { tool: "claude", pausedUntil: 5_060_000 },
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
        startTask: async (_taskId) => {
          currentTask = {
            ...currentTask,
            status: "running",
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
        findActiveBySource: async () => [],
        markSuperseded: async () => {
          throw new Error("markSuperseded not exercised in this test");
        },
        recoverRunningTasks: async () => {},
        pruneTerminalTasks: async () => 0,
      },
      schedulerService: new SchedulerService({ maxConcurrency: 2 }),
      toolsForTask: stubToolsForTask,
      runStrategy: async () => {
        throw new Error("getSourceContext network failure");
      },
      logStore: {
        write: async () => {},
        cleanupExpired: async () => {},
      },
      pollIntervalMs: 10,
      notifications: {
        onFailure: async (task, errorSummary) => {
          notified.push({ taskId: task.taskId, errorSummary });
        },
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
        startTask: async (_taskId) => {
          currentTask = {
            ...currentTask,
            status: "running",
            startedAt: "2026-04-27T00:01:00.000Z",
          };
          return currentTask;
        },
        completeTask: async () => {
          throw new Error("completeTask should not run for rate-limited tasks");
        },
        revertToQueued: async () => currentTask,
        findActiveBySource: async () => [],
        markSuperseded: async () => {
          throw new Error("markSuperseded not exercised in this test");
        },
        recoverRunningTasks: async () => {},
        pruneTerminalTasks: async () => 0,
      },
      schedulerService: new SchedulerService({ maxConcurrency: 2 }),
      toolsForTask: stubToolsForTask,
      runStrategy: async () => ({ status: "rate_limited", toolName: "claude" }),
      logStore: {
        write: async () => {},
        cleanupExpired: async () => {},
      },
      pollIntervalMs: 10,
      notifications: {
        onFailure: async (task) => {
          notified.push(task.taskId);
        },
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
        startTask: async (_taskId) => {
          currentTask = {
            ...currentTask,
            status: "running",
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
        findActiveBySource: async () => [],
        markSuperseded: async () => {
          throw new Error("markSuperseded not exercised in this test");
        },
        recoverRunningTasks: async () => {},
        pruneTerminalTasks: async () => 0,
      },
      schedulerService: new SchedulerService({ maxConcurrency: 2 }),
      toolsForTask: stubToolsForTask,
      runStrategy: async () => ({
        status: "failed",
        errorSummary: "boom",
      }),
      logStore: {
        write: async () => {},
        cleanupExpired: async () => {},
      },
      pollIntervalMs: 10,
      clock: { warn: (message) => warnings.push(message) },
      notifications: {
        onFailure: async () => {
          throw new Error("notify failed");
        },
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

  test("calls notifyTaskSucceeded when execution succeeds", async () => {
    const notifiedSucceeded: string[] = [];
    let currentTask = createTask("queued");

    const daemon = new RunnerDaemon({
      queueStore: {
        enqueue: async () => currentTask,
        listTasks: async () => [currentTask],
        getTask: async () => currentTask,
        startTask: async (_taskId) => {
          currentTask = {
            ...currentTask,
            status: "running",
            startedAt: "2026-04-27T00:01:00.000Z",
          };
          return currentTask;
        },
        completeTask: async (_taskId, input) => {
          currentTask = {
            ...currentTask,
            status: input.status,
          };
          return currentTask;
        },
        revertToQueued: async () => currentTask,
        findActiveBySource: async () => [],
        markSuperseded: async () => {
          throw new Error("markSuperseded not exercised in this test");
        },
        recoverRunningTasks: async () => {},
        pruneTerminalTasks: async () => 0,
      },
      schedulerService: new SchedulerService({ maxConcurrency: 2 }),
      toolsForTask: stubToolsForTask,
      runStrategy: async () => ({ status: "succeeded" }),
      logStore: {
        write: async () => {},
        cleanupExpired: async () => {},
      },
      pollIntervalMs: 10,
      notifications: {
        onSucceeded: async (task) => {
          notifiedSucceeded.push(task.taskId);
        },
      },
    });

    await daemon.tick();
    await daemon.waitForIdle();

    assert.deepEqual(notifiedSucceeded, ["task_1"]);
  });

  test("calls notifyTaskRateLimited before pausing the tool", async () => {
    const notifiedRateLimited: string[] = [];
    let currentTask = createTask("queued");

    const daemon = new RunnerDaemon({
      queueStore: {
        enqueue: async () => currentTask,
        listTasks: async () => [currentTask],
        getTask: async () => currentTask,
        startTask: async (_taskId) => {
          currentTask = {
            ...currentTask,
            status: "running",
            startedAt: "2026-04-27T00:01:00.000Z",
          };
          return currentTask;
        },
        completeTask: async () => {
          throw new Error("completeTask should not run for rate-limited tasks");
        },
        revertToQueued: async () => currentTask,
        findActiveBySource: async () => [],
        markSuperseded: async () => {
          throw new Error("markSuperseded not exercised in this test");
        },
        recoverRunningTasks: async () => {},
        pruneTerminalTasks: async () => 0,
      },
      schedulerService: new SchedulerService({ maxConcurrency: 2 }),
      toolsForTask: stubToolsForTask,
      runStrategy: async () => ({
        status: "rate_limited",
        toolName: "claude",
      }),
      logStore: {
        write: async () => {},
        cleanupExpired: async () => {},
      },
      pollIntervalMs: 10,
      notifications: {
        onRateLimited: async (task) => {
          notifiedRateLimited.push(task.taskId);
        },
      },
    });

    await daemon.tick();
    await daemon.waitForIdle();

    assert.deepEqual(notifiedRateLimited, ["task_1"]);
  });

  test("supersede aborts a running task and persists supersededBy without notifying failure", async () => {
    const calls: string[] = [];
    let currentTask = createTask("queued");
    const supersededNotifications: Array<{
      taskId: string;
      supersededBy: string;
    }> = [];

    let resolveStrategy: ((value: { status: "failed"; errorSummary: string }) => void) | undefined;
    const strategyPromise = new Promise<{ status: "failed"; errorSummary: string }>(
      (resolve) => {
        resolveStrategy = resolve;
      },
    );

    const daemon = new RunnerDaemon({
      queueStore: {
        enqueue: async () => currentTask,
        listTasks: async () => [currentTask],
        getTask: async () => currentTask,
        startTask: async (taskId) => {
          calls.push(`start:${taskId}`);
          currentTask = {
            ...currentTask,
            status: "running",
            startedAt: "2026-04-30T00:01:00.000Z",
          };
          return currentTask;
        },
        completeTask: async () => {
          calls.push("complete");
          throw new Error("completeTask should not run for superseded tasks");
        },
        revertToQueued: async () => currentTask,
        findActiveBySource: async () => [],
        markSuperseded: async (taskId, supersededBy) => {
          calls.push(`markSuperseded:${taskId}:${supersededBy}`);
          currentTask = {
            ...currentTask,
            status: "superseded",
            supersededBy,
            finishedAt: "2026-04-30T00:02:00.000Z",
          };
          return currentTask;
        },
        recoverRunningTasks: async () => {},
        pruneTerminalTasks: async () => 0,
      },
      schedulerService: new SchedulerService({ maxConcurrency: 2 }),
      toolsForTask: stubToolsForTask,
      runStrategy: async (_task, signal) => {
        signal.addEventListener("abort", () => {
          resolveStrategy?.({
            status: "failed",
            errorSummary: "aborted",
          });
        });
        return strategyPromise;
      },
      logStore: {
        write: async () => {},
        cleanupExpired: async () => {},
      },
      pollIntervalMs: 10,
      notifications: {
        onFailure: async () => {
          calls.push("notifyFailure");
        },
        onSuperseded: async (task, supersededBy) => {
          supersededNotifications.push({ taskId: task.taskId, supersededBy });
        },
      },
    });

    await daemon.tick();
    // Task is now running; trigger supersede.
    await daemon.supersede("task_1", "task_2");
    await daemon.waitForIdle();

    assert.deepEqual(supersededNotifications, [
      { taskId: "task_1", supersededBy: "task_2" },
    ]);
    assert.ok(
      calls.includes("markSuperseded:task_1:task_2"),
      `expected markSuperseded call, got: ${calls.join(", ")}`,
    );
    assert.equal(
      calls.includes("notifyFailure"),
      false,
      "supersede must not trigger the failure notifier",
    );
  });

  test("sweepStaleRunning recovers stale running tasks not in activeTasks", async () => {
    const completeCalls: Array<{
      taskId: string;
      status: string;
      errorSummary?: string;
    }> = [];
    const warnings: string[] = [];
    const staleTask: TaskRecord = {
      ...createTask("running"),
      taskId: "task_stale_1",
      startedAt: "2026-04-30T00:00:00.000Z",
    };

    const daemon = new RunnerDaemon({
      queueStore: {
        enqueue: async () => staleTask,
        listTasks: async () => [staleTask],
        getTask: async () => staleTask,
        startTask: async () => staleTask,
        completeTask: async (taskId, input) => {
          completeCalls.push({
            taskId,
            status: input.status,
            ...(input.errorSummary !== undefined
              ? { errorSummary: input.errorSummary }
              : {}),
          });
          return { ...staleTask, status: input.status };
        },
        revertToQueued: async () => staleTask,
        findActiveBySource: async () => [],
        markSuperseded: async () => {
          throw new Error("markSuperseded not exercised in this test");
        },
        recoverRunningTasks: async () => {},
        pruneTerminalTasks: async () => 0,
      },
      schedulerService: new SchedulerService({ maxConcurrency: 2 }),
      toolsForTask: stubToolsForTask,
      runStrategy: async () => ({ status: "succeeded" }),
      logStore: {
        write: async () => {},
        cleanupExpired: async () => {},
      },
      pollIntervalMs: 10,
      staleRunning: { cutoffMs: 60_000 },
      // 90s past the staleTask startedAt (2026-04-30T00:00:00) -> 30s over cutoff
      clock: {
        now: () => Date.parse("2026-04-30T00:01:30.000Z"),
        warn: (message) => warnings.push(message),
      },
    });

    await daemon.tick();
    await daemon.waitForIdle();

    assert.equal(completeCalls.length, 1);
    assert.equal(completeCalls[0]?.taskId, "task_stale_1");
    assert.equal(completeCalls[0]?.status, "failed");
    assert.match(
      completeCalls[0]?.errorSummary ?? "",
      /stale running/,
    );
  });

  test("sweepStaleRunning skips tasks present in activeTasks", async () => {
    const completeCalls: string[] = [];
    let release: (() => void) | undefined;
    const strategyPromise = new Promise<{ status: "succeeded" }>((resolve) => {
      release = () => resolve({ status: "succeeded" });
    });
    let currentTask: TaskRecord = {
      ...createTask("queued"),
      taskId: "task_active_1",
    };

    const daemon = new RunnerDaemon({
      queueStore: {
        enqueue: async () => currentTask,
        listTasks: async () => [currentTask],
        getTask: async () => currentTask,
        startTask: async () => {
          // Task transitions queued -> running with a very old startedAt to
          // ensure cutoff would otherwise mark it stale.
          currentTask = {
            ...currentTask,
            status: "running",
            startedAt: "2026-04-30T00:00:00.000Z",
          };
          return currentTask;
        },
        completeTask: async (taskId, input) => {
          completeCalls.push(`${taskId}:${input.status}`);
          return { ...currentTask, status: input.status };
        },
        revertToQueued: async () => currentTask,
        findActiveBySource: async () => [],
        markSuperseded: async () => {
          throw new Error("markSuperseded not exercised in this test");
        },
        recoverRunningTasks: async () => {},
        pruneTerminalTasks: async () => 0,
      },
      schedulerService: new SchedulerService({ maxConcurrency: 2 }),
      toolsForTask: stubToolsForTask,
      runStrategy: async () => strategyPromise,
      logStore: {
        write: async () => {},
        cleanupExpired: async () => {},
      },
      pollIntervalMs: 10,
      staleRunning: { cutoffMs: 60_000 },
      clock: { now: () => Date.parse("2026-04-30T00:10:00.000Z") },
    });

    // First tick: task is queued -> startTask moves it to running and adds it
    // to activeTasks (strategy is pending).
    await daemon.tick();
    // Second tick: task is in activeTasks. listTasks returns it as running
    // with old startedAt, but sweep must skip it.
    await daemon.tick();

    // Release strategy so the daemon can drain.
    release?.();
    await daemon.waitForIdle();

    // The only completeTask call is the legitimate succeeded one.
    assert.deepEqual(completeCalls, ["task_active_1:succeeded"]);
  });

  test("sweepStaleRunning skips running tasks under cutoff", async () => {
    const completeCalls: string[] = [];
    const recentTask: TaskRecord = {
      ...createTask("running"),
      taskId: "task_recent_1",
      startedAt: "2026-04-30T00:00:30.000Z",
    };

    const daemon = new RunnerDaemon({
      queueStore: {
        enqueue: async () => recentTask,
        listTasks: async () => [recentTask],
        getTask: async () => recentTask,
        startTask: async () => recentTask,
        completeTask: async (taskId, input) => {
          completeCalls.push(`${taskId}:${input.status}`);
          return { ...recentTask, status: input.status };
        },
        revertToQueued: async () => recentTask,
        findActiveBySource: async () => [],
        markSuperseded: async () => {
          throw new Error("markSuperseded not exercised in this test");
        },
        recoverRunningTasks: async () => {},
        pruneTerminalTasks: async () => 0,
      },
      schedulerService: new SchedulerService({ maxConcurrency: 2 }),
      toolsForTask: stubToolsForTask,
      runStrategy: async () => ({ status: "succeeded" }),
      logStore: {
        write: async () => {},
        cleanupExpired: async () => {},
      },
      pollIntervalMs: 10,
      staleRunning: { cutoffMs: 60_000 },
      // Only 45s past startedAt -> below 60s cutoff.
      clock: { now: () => Date.parse("2026-04-30T00:01:15.000Z") },
    });

    await daemon.tick();
    await daemon.waitForIdle();

    assert.deepEqual(completeCalls, []);
  });

  test("daemon survives when completeTask throws and logs the failed transition", async () => {
    const warnings: string[] = [];
    const logCalls: Array<{ taskId: string; message: string }> = [];
    let currentTask = createTask("queued");

    const daemon = new RunnerDaemon({
      queueStore: {
        enqueue: async () => currentTask,
        listTasks: async () => [currentTask],
        getTask: async () => currentTask,
        startTask: async () => {
          currentTask = {
            ...currentTask,
            status: "running",
            startedAt: "2026-04-27T00:01:00.000Z",
          };
          return currentTask;
        },
        completeTask: async () => {
          throw new Error("disk full");
        },
        revertToQueued: async () => currentTask,
        findActiveBySource: async () => [],
        markSuperseded: async () => {
          throw new Error("markSuperseded not exercised in this test");
        },
        recoverRunningTasks: async () => {},
        pruneTerminalTasks: async () => 0,
      },
      schedulerService: new SchedulerService({ maxConcurrency: 2 }),
      toolsForTask: stubToolsForTask,
      runStrategy: async () => ({ status: "succeeded" }),
      logStore: {
        write: async (taskId, message) => {
          logCalls.push({ taskId, message });
        },
        cleanupExpired: async () => {},
      },
      pollIntervalMs: 10,
      clock: { warn: (message) => warnings.push(message) },
    });

    await daemon.tick();
    await daemon.waitForIdle();

    assert.ok(
      warnings.some(
        (m) =>
          m.includes("completeTask failed") &&
          m.includes("task=task_1") &&
          m.includes("from=running") &&
          m.includes("to=succeeded") &&
          m.includes("disk full"),
      ),
      `expected completeTask failure warning, got: ${warnings.join(", ")}`,
    );
    assert.ok(
      logCalls.some(
        (c) =>
          c.taskId === "task_1" &&
          c.message.includes("completeTask failed") &&
          c.message.includes("running -> succeeded"),
      ),
      `expected logStore write for completeTask failure, got: ${JSON.stringify(logCalls)}`,
    );
  });

  test("daemon survives when revertToQueued throws and logs the failed transition", async () => {
    const warnings: string[] = [];
    const logCalls: Array<{ taskId: string; message: string }> = [];
    let currentTask = createTask("queued");

    const daemon = new RunnerDaemon({
      queueStore: {
        enqueue: async () => currentTask,
        listTasks: async () => [currentTask],
        getTask: async () => currentTask,
        startTask: async () => {
          currentTask = {
            ...currentTask,
            status: "running",
            startedAt: "2026-04-27T00:01:00.000Z",
          };
          return currentTask;
        },
        completeTask: async () => {
          throw new Error("completeTask should not run for rate-limited tasks");
        },
        revertToQueued: async () => {
          throw new Error("rename across devices");
        },
        findActiveBySource: async () => [],
        markSuperseded: async () => {
          throw new Error("markSuperseded not exercised in this test");
        },
        recoverRunningTasks: async () => {},
        pruneTerminalTasks: async () => 0,
      },
      schedulerService: new SchedulerService({ maxConcurrency: 2 }),
      toolsForTask: stubToolsForTask,
      runStrategy: async () => ({
        status: "rate_limited",
        toolName: "claude",
      }),
      logStore: {
        write: async (taskId, message) => {
          logCalls.push({ taskId, message });
        },
        cleanupExpired: async () => {},
      },
      pollIntervalMs: 10,
      clock: { warn: (message) => warnings.push(message) },
    });

    await daemon.tick();
    await daemon.waitForIdle();

    assert.ok(
      warnings.some(
        (m) =>
          m.includes("revertToQueued failed") &&
          m.includes("task=task_1") &&
          m.includes("from=running") &&
          m.includes("to=queued") &&
          m.includes("rename across devices"),
      ),
      `expected revertToQueued failure warning, got: ${warnings.join(", ")}`,
    );
    assert.ok(
      logCalls.some(
        (c) =>
          c.taskId === "task_1" &&
          c.message.includes("revertToQueued failed") &&
          c.message.includes("running -> queued"),
      ),
      `expected logStore write for revertToQueued failure, got: ${JSON.stringify(logCalls)}`,
    );
  });
});
