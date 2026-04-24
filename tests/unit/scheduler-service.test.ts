import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { InstructionDefinition } from "../../src/domain/instruction.js";
import type { TaskRecord } from "../../src/domain/task.js";
import { SchedulerService } from "../../src/services/scheduler-service.js";

const observeInstruction: InstructionDefinition = {
  id: "issue-comment-opinion",
  revision: 1,
  sourceKind: "issue",
  mode: "observe",
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
    agent: "codex-cli",
    timeoutSec: 1800,
  },
};

const mutateInstruction: InstructionDefinition = {
  id: "issue-to-pr",
  revision: 1,
  sourceKind: "issue",
  mode: "mutate",
  context: {},
  permissions: {
    codeRead: true,
    codeWrite: true,
    gitPush: true,
    prCreate: true,
    prUpdate: true,
    commentWrite: true,
  },
  githubActions: ["branch_push", "pr_create", "issue_comment"],
  execution: {
    agent: "codex-cli",
    timeoutSec: 3600,
  },
};

function createTask(
  taskId: string,
  instructionId: string,
  status: TaskRecord["status"],
  repoName: string,
): TaskRecord {
  return {
    taskId,
    repo: { owner: "octo", name: repoName },
    source: { kind: "issue", number: Number(taskId.replace(/\D/g, "")) || 1 },
    instructionId,
    status,
    priority: "normal",
    requestedBy: "test",
    createdAt: "2026-04-24T00:00:00.000Z",
  };
}

describe("SchedulerService", () => {
  test("does not schedule same-repo mutate when one is already running", () => {
    const scheduler = new SchedulerService({ maxConcurrency: 2 });

    const selected = scheduler.selectNextTasks({
      tasks: [
        createTask("task_running", "issue-to-pr", "running", "repo-a"),
        createTask("task_queued", "issue-to-pr", "queued", "repo-a"),
      ],
      instructionsById: {
        "issue-to-pr": mutateInstruction,
      },
    });

    assert.deepEqual(selected, []);
  });

  test("allows observe work while same-repo mutate is running", () => {
    const scheduler = new SchedulerService({ maxConcurrency: 2 });

    const selected = scheduler.selectNextTasks({
      tasks: [
        createTask("task_running", "issue-to-pr", "running", "repo-a"),
        createTask("task_queued", "issue-comment-opinion", "queued", "repo-a"),
      ],
      instructionsById: {
        "issue-to-pr": mutateInstruction,
        "issue-comment-opinion": observeInstruction,
      },
    });

    assert.deepEqual(selected, ["task_queued"]);
  });

  test("fills free slots with executable queued work in created order", () => {
    const scheduler = new SchedulerService({ maxConcurrency: 2 });

    const selected = scheduler.selectNextTasks({
      tasks: [
        createTask("task_1", "issue-to-pr", "queued", "repo-a"),
        createTask("task_2", "issue-comment-opinion", "queued", "repo-a"),
        createTask("task_3", "issue-to-pr", "queued", "repo-b"),
      ],
      instructionsById: {
        "issue-to-pr": mutateInstruction,
        "issue-comment-opinion": observeInstruction,
      },
    });

    assert.deepEqual(selected, ["task_1", "task_2"]);
  });
});
