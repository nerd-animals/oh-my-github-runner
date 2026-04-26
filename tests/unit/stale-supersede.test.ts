import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TaskRecord } from "../../src/domain/task.js";
import { isObserveResultSuperseded } from "../../src/services/stale-supersede.js";

const baseTask: TaskRecord = {
  taskId: "task_current",
  repo: { owner: "octo", name: "repo" },
  source: { kind: "issue", number: 100 },
  instructionId: "issue-comment-reply",
  agent: "claude",
  status: "running",
  priority: "normal",
  requestedBy: "alice",
  createdAt: "2026-04-26T10:00:00.000Z",
};

function withOverrides(overrides: Partial<TaskRecord>): TaskRecord {
  return { ...baseTask, ...overrides };
}

describe("isObserveResultSuperseded", () => {
  test("returns false when there are no other tasks", () => {
    assert.equal(isObserveResultSuperseded(baseTask, []), false);
  });

  test("returns true when a newer queued task targets the same source and instruction", () => {
    const newer = withOverrides({
      taskId: "task_newer",
      status: "queued",
      createdAt: "2026-04-26T10:05:00.000Z",
    });

    assert.equal(isObserveResultSuperseded(baseTask, [newer]), true);
  });

  test("returns true when a newer running task exists", () => {
    const newer = withOverrides({
      taskId: "task_newer",
      status: "running",
      createdAt: "2026-04-26T10:05:00.000Z",
    });

    assert.equal(isObserveResultSuperseded(baseTask, [newer]), true);
  });

  test("returns false for a different instructionId on the same source", () => {
    const other = withOverrides({
      taskId: "task_other",
      instructionId: "issue-implement",
      status: "queued",
      createdAt: "2026-04-26T10:05:00.000Z",
    });

    assert.equal(isObserveResultSuperseded(baseTask, [other]), false);
  });

  test("returns false for a different source number", () => {
    const other = withOverrides({
      taskId: "task_other",
      source: { kind: "issue", number: 999 },
      status: "queued",
      createdAt: "2026-04-26T10:05:00.000Z",
    });

    assert.equal(isObserveResultSuperseded(baseTask, [other]), false);
  });

  test("returns false for an older task", () => {
    const older = withOverrides({
      taskId: "task_older",
      status: "queued",
      createdAt: "2026-04-26T09:55:00.000Z",
    });

    assert.equal(isObserveResultSuperseded(baseTask, [older]), false);
  });

  test("returns false for a completed (succeeded/failed/superseded) task", () => {
    const completed = withOverrides({
      taskId: "task_done",
      status: "succeeded",
      createdAt: "2026-04-26T10:05:00.000Z",
    });

    assert.equal(isObserveResultSuperseded(baseTask, [completed]), false);
  });

  test("returns false when the candidate is the current task itself", () => {
    assert.equal(isObserveResultSuperseded(baseTask, [baseTask]), false);
  });
});
