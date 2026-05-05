import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RunnerStatusService } from "../../src/services/runner-status-service.js";
import type { TaskRecord } from "../../src/domain/task.js";

function record(
  taskId: string,
  status: TaskRecord["status"],
  instructionId: string,
): TaskRecord {
  return {
    taskId,
    repo: { owner: "octo", name: "repo" },
    source: { kind: "issue", number: 1 },
    instructionId,
    status,
    priority: "normal",
    requestedBy: "test",
    createdAt: new Date().toISOString(),
  };
}

const toolsByInstruction: Record<string, readonly string[]> = {
  "issue-implement": ["claude"],
  "issue-initial-review": ["codex", "claude"],
  "pr-implement": ["claude"],
};

const toolsForTask = (task: TaskRecord): readonly string[] =>
  toolsByInstruction[task.instructionId] ?? [];

describe("RunnerStatusService", () => {
  test("counts tasks across every status and reports all runners idle when nothing is running", async () => {
    const tasks: TaskRecord[] = [
      record("a", "queued", "issue-implement"),
      record("b", "queued", "issue-implement"),
      record("c", "succeeded", "issue-implement"),
      record("d", "failed", "issue-implement"),
      record("e", "superseded", "issue-implement"),
    ];

    const service = new RunnerStatusService({
      queueStore: { listTasks: async () => tasks },
      registeredTools: ["claude", "codex"],
      toolsForTask,
    });

    const summary = await service.getStatus();

    assert.equal(summary.status, "ok");
    assert.deepEqual(summary.tasks, {
      queued: 2,
      running: 0,
      succeeded: 1,
      failed: 1,
      superseded: 1,
    });
    assert.deepEqual(summary.runners, [
      { tool: "claude", status: "idle" },
      { tool: "codex", status: "idle" },
    ]);
  });

  test("marks tools busy only when a running task uses them", async () => {
    const tasks: TaskRecord[] = [
      record("a", "running", "issue-implement"),
      record("b", "queued", "issue-initial-review"),
    ];

    const service = new RunnerStatusService({
      queueStore: { listTasks: async () => tasks },
      registeredTools: ["claude", "codex"],
      toolsForTask,
    });

    const summary = await service.getStatus();

    assert.deepEqual(summary.tasks, {
      queued: 1,
      running: 1,
      succeeded: 0,
      failed: 0,
      superseded: 0,
    });
    assert.deepEqual(summary.runners, [
      { tool: "claude", status: "busy" },
      { tool: "codex", status: "idle" },
    ]);
  });

  test("aggregates busy tools across multiple running tasks", async () => {
    const tasks: TaskRecord[] = [
      record("a", "running", "issue-implement"),
      record("b", "running", "issue-initial-review"),
    ];

    const service = new RunnerStatusService({
      queueStore: { listTasks: async () => tasks },
      registeredTools: ["claude", "codex"],
      toolsForTask,
    });

    const summary = await service.getStatus();

    assert.deepEqual(summary.runners, [
      { tool: "claude", status: "busy" },
      { tool: "codex", status: "busy" },
    ]);
  });

  test("handles an empty queue", async () => {
    const service = new RunnerStatusService({
      queueStore: { listTasks: async () => [] },
      registeredTools: ["claude"],
      toolsForTask,
    });

    const summary = await service.getStatus();

    assert.deepEqual(summary.tasks, {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      superseded: 0,
    });
    assert.deepEqual(summary.runners, [{ tool: "claude", status: "idle" }]);
  });
});
