import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TaskRecord } from "../../src/domain/task.js";
import { SchedulerService } from "../../src/services/scheduler-service.js";

function createTask(
  taskId: string,
  status: TaskRecord["status"],
  repoName: string,
  tool: string = "claude",
): TaskRecord {
  return {
    taskId,
    repo: { owner: "octo", name: repoName },
    source: { kind: "issue", number: Number(taskId.replace(/\D/g, "")) || 1 },
    instructionId: "issue-comment-reply",
    tool,
    status,
    priority: "normal",
    requestedBy: "test",
    createdAt: "2026-04-24T00:00:00.000Z",
  };
}

describe("SchedulerService", () => {
  test("schedules same-repo work concurrently - branch suffix removes the collision", () => {
    const scheduler = new SchedulerService({ maxConcurrency: 2 });

    const selected = scheduler.selectNextTasks({
      tasks: [
        createTask("task_running", "running", "repo-a"),
        createTask("task_queued", "queued", "repo-a"),
      ],
    });

    assert.deepEqual(selected, ["task_queued"]);
  });

  test("skips queued tasks whose tool is paused", () => {
    const scheduler = new SchedulerService({ maxConcurrency: 2 });

    const selected = scheduler.selectNextTasks({
      tasks: [
        createTask("task_paused", "queued", "repo-a"),
        createTask("task_active", "queued", "repo-b"),
      ],
      pausedTools: new Set(["claude"]),
    });

    assert.deepEqual(selected, []);
  });

  test("fills free slots with executable queued work in created order", () => {
    const scheduler = new SchedulerService({ maxConcurrency: 2 });

    const selected = scheduler.selectNextTasks({
      tasks: [
        createTask("task_1", "queued", "repo-a"),
        createTask("task_2", "queued", "repo-a"),
        createTask("task_3", "queued", "repo-b"),
      ],
    });

    assert.deepEqual(selected, ["task_1", "task_2"]);
  });

  test("respects the concurrency budget when work is already running", () => {
    const scheduler = new SchedulerService({ maxConcurrency: 2 });

    const selected = scheduler.selectNextTasks({
      tasks: [
        createTask("task_r1", "running", "repo-a"),
        createTask("task_r2", "running", "repo-b"),
        createTask("task_q", "queued", "repo-c"),
      ],
    });

    assert.deepEqual(selected, []);
  });
});
