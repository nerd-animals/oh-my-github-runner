import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { InstructionDefinition } from "../../src/domain/instruction.js";
import type { TaskRecord } from "../../src/domain/task.js";
import { SchedulerService } from "../../src/services/scheduler-service.js";

const observeInstruction: InstructionDefinition = {
  id: "issue-comment-reply",
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
    timeoutSec: 1800,
  },
};

const mutateInstruction: InstructionDefinition = {
  id: "issue-implement",
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
    agent: "claude",
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
        createTask("task_running", "issue-implement", "running", "repo-a"),
        createTask("task_queued", "issue-implement", "queued", "repo-a"),
      ],
      instructionsById: {
        "issue-implement": mutateInstruction,
      },
    });

    assert.deepEqual(selected, []);
  });

  test("allows observe work while same-repo mutate is running", () => {
    const scheduler = new SchedulerService({ maxConcurrency: 2 });

    const selected = scheduler.selectNextTasks({
      tasks: [
        createTask("task_running", "issue-implement", "running", "repo-a"),
        createTask("task_queued", "issue-comment-reply", "queued", "repo-a"),
      ],
      instructionsById: {
        "issue-implement": mutateInstruction,
        "issue-comment-reply": observeInstruction,
      },
    });

    assert.deepEqual(selected, ["task_queued"]);
  });

  test("skips queued tasks whose agent is paused", () => {
    const scheduler = new SchedulerService({ maxConcurrency: 2 });

    const selected = scheduler.selectNextTasks({
      tasks: [
        createTask("task_paused", "issue-comment-reply", "queued", "repo-a"),
        createTask("task_active", "issue-comment-reply", "queued", "repo-b"),
      ],
      instructionsById: {
        "issue-comment-reply": observeInstruction,
      },
      pausedAgents: new Set(["claude"]),
    });

    assert.deepEqual(selected, []);
  });

  test("fills free slots with executable queued work in created order", () => {
    const scheduler = new SchedulerService({ maxConcurrency: 2 });

    const selected = scheduler.selectNextTasks({
      tasks: [
        createTask("task_1", "issue-implement", "queued", "repo-a"),
        createTask("task_2", "issue-comment-reply", "queued", "repo-a"),
        createTask("task_3", "issue-implement", "queued", "repo-b"),
      ],
      instructionsById: {
        "issue-implement": mutateInstruction,
        "issue-comment-reply": observeInstruction,
      },
    });

    assert.deepEqual(selected, ["task_1", "task_2"]);
  });
});
