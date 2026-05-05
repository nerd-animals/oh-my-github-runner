import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TaskRecord } from "../../src/domain/task.js";
import { SchedulerService } from "../../src/services/scheduler-service.js";

function createTask(
  taskId: string,
  status: TaskRecord["status"],
  repoName: string,
): TaskRecord {
  return {
    taskId,
    repo: { owner: "octo", name: repoName },
    source: { kind: "issue", number: Number(taskId.replace(/\D/g, "")) || 1 },
    instructionId: "issue-comment-reply",
    status,
    priority: "normal",
    requestedBy: "test",
    createdAt: "2026-04-24T00:00:00.000Z",
  };
}

const claudeOnly = (): readonly string[] => ["claude"];

describe("SchedulerService", () => {
  test("schedules same-repo work concurrently - branch suffix removes the collision", () => {
    const scheduler = new SchedulerService({ maxConcurrency: 2 });

    // Different tools so the per-tool cap (#110) is not what's being tested
    // here. The point of this case is that two tasks targeting the same repo
    // are NOT serialized at the scheduler level.
    const selected = scheduler.selectNextTasks({
      tasks: [
        createTask("task_running", "running", "repo-a"),
        createTask("task_queued", "queued", "repo-a"),
      ],
      toolsForTask: (task) =>
        task.taskId === "task_running" ? ["claude"] : ["codex"],
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
      toolsForTask: claudeOnly,
    });

    assert.deepEqual(selected, []);
  });

  test("skips a task if any of its declared tools is paused (any-paused = defer)", () => {
    const scheduler = new SchedulerService({ maxConcurrency: 2 });

    const selected = scheduler.selectNextTasks({
      tasks: [
        createTask("task_multi", "queued", "repo-a"),
        createTask("task_solo", "queued", "repo-b"),
      ],
      pausedTools: new Set(["codex"]),
      toolsForTask: (task) =>
        task.taskId === "task_multi" ? ["claude", "codex"] : ["claude"],
    });

    assert.deepEqual(selected, ["task_solo"]);
  });

  test("fills free slots with executable queued work in created order", () => {
    const scheduler = new SchedulerService({ maxConcurrency: 2 });

    // Distinct tools per task so slot-filling is what's measured, not the
    // per-tool cap (#110). With same-tool tasks, only one would be picked.
    const toolByTask: Record<string, readonly string[]> = {
      task_1: ["claude"],
      task_2: ["codex"],
      task_3: ["gemini"],
    };

    const selected = scheduler.selectNextTasks({
      tasks: [
        createTask("task_1", "queued", "repo-a"),
        createTask("task_2", "queued", "repo-a"),
        createTask("task_3", "queued", "repo-b"),
      ],
      toolsForTask: (task) => toolByTask[task.taskId] ?? [],
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
      toolsForTask: claudeOnly,
    });

    assert.deepEqual(selected, []);
  });

  test("caps queued same-tool dispatches to one per tick (#110)", () => {
    // Two queued tasks both wanting claude. Without the per-tool cap, both
    // would be dispatched in one tick and both would race to a 429.
    const scheduler = new SchedulerService({ maxConcurrency: 2 });

    const selected = scheduler.selectNextTasks({
      tasks: [
        createTask("task_1", "queued", "repo-a"),
        createTask("task_2", "queued", "repo-b"),
      ],
      toolsForTask: claudeOnly,
    });

    assert.deepEqual(selected, ["task_1"]);
  });

  test("skips queued task when its tool is already used by a running task (#110)", () => {
    const scheduler = new SchedulerService({ maxConcurrency: 2 });

    const selected = scheduler.selectNextTasks({
      tasks: [
        createTask("task_running", "running", "repo-a"),
        createTask("task_queued", "queued", "repo-b"),
      ],
      toolsForTask: claudeOnly,
    });

    assert.deepEqual(selected, []);
  });

  test("schedules queued task when running task uses a different tool (#110)", () => {
    const scheduler = new SchedulerService({ maxConcurrency: 2 });

    const selected = scheduler.selectNextTasks({
      tasks: [
        createTask("task_running", "running", "repo-a"),
        createTask("task_queued", "queued", "repo-b"),
      ],
      toolsForTask: (task) =>
        task.taskId === "task_running" ? ["claude"] : ["codex"],
    });

    assert.deepEqual(selected, ["task_queued"]);
  });

  test("skips later same-tool queued tasks but picks distinct-tool queued tasks (#110)", () => {
    // Queue: [claude, codex, claude]. concurrency=2. The first claude task
    // claims claude, codex slot is free, second claude is skipped.
    const scheduler = new SchedulerService({ maxConcurrency: 2 });

    const toolByTask: Record<string, readonly string[]> = {
      task_1: ["claude"],
      task_2: ["codex"],
      task_3: ["claude"],
    };

    const selected = scheduler.selectNextTasks({
      tasks: [
        createTask("task_1", "queued", "repo-a"),
        createTask("task_2", "queued", "repo-a"),
        createTask("task_3", "queued", "repo-a"),
      ],
      toolsForTask: (task) => toolByTask[task.taskId] ?? [],
    });

    assert.deepEqual(selected, ["task_1", "task_2"]);
  });

  test("defers every task when 'github' is paused (global tool)", () => {
    // 'github' is not declared in any strategy's policies.uses; it is an
    // implicit dependency for every task. When the runner-side GitHub
    // client trips its rate-limit and pauses 'github', the scheduler must
    // defer everything regardless of what each task's AI tool is.
    const scheduler = new SchedulerService({ maxConcurrency: 2 });

    const selected = scheduler.selectNextTasks({
      tasks: [
        createTask("task_claude", "queued", "repo-a"),
        createTask("task_codex", "queued", "repo-b"),
      ],
      pausedTools: new Set(["github"]),
      toolsForTask: (task) =>
        task.taskId === "task_codex" ? ["codex"] : ["claude"],
    });

    assert.deepEqual(selected, []);
  });

  test("non-global paused tools still allow tasks on other tools", () => {
    // Sanity: regression check that the global-pause shortcut does not
    // leak into per-tool pausing. claude paused, github clear → codex
    // task should still run.
    const scheduler = new SchedulerService({ maxConcurrency: 2 });

    const selected = scheduler.selectNextTasks({
      tasks: [
        createTask("task_claude", "queued", "repo-a"),
        createTask("task_codex", "queued", "repo-b"),
      ],
      pausedTools: new Set(["claude"]),
      toolsForTask: (task) =>
        task.taskId === "task_codex" ? ["codex"] : ["claude"],
    });

    assert.deepEqual(selected, ["task_codex"]);
  });

  test("multi-tool running task claims every declared tool (#110)", () => {
    // issue-initial-review style: declares claude + codex even though one
    // task only runs them sequentially. A queued task using either tool
    // must wait until the multi-tool task finishes.
    const scheduler = new SchedulerService({ maxConcurrency: 2 });

    const toolByTask: Record<string, readonly string[]> = {
      task_running: ["claude", "codex"],
      task_q_claude: ["claude"],
      task_q_codex: ["codex"],
    };

    const selected = scheduler.selectNextTasks({
      tasks: [
        createTask("task_running", "running", "repo-a"),
        createTask("task_q_claude", "queued", "repo-a"),
        createTask("task_q_codex", "queued", "repo-a"),
      ],
      toolsForTask: (task) => toolByTask[task.taskId] ?? [],
    });

    assert.deepEqual(selected, []);
  });
});
