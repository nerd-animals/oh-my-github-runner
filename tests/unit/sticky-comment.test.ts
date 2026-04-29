import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TaskRecord } from "../../src/domain/task.js";
import {
  REJECTION_MARKER,
  renderFailure,
  renderQueued,
  renderRateLimited,
  renderRejection,
  renderSuperseded,
  stickyCommentMarker,
  type StickyCommentMeta,
} from "../../src/services/sticky-comment.js";

const meta: StickyCommentMeta = {
  taskId: "task_abc_123",
  instructionId: "issue-initial-review",
  tool: "claude",
  requestedBy: "alice",
  trigger: { kind: "issue", issueNumber: 7 },
};

const task: TaskRecord = {
  taskId: "task_abc_123",
  repo: { owner: "octo", name: "repo" },
  source: { kind: "issue", number: 7 },
  instructionId: "issue-initial-review",
  tool: "claude",
  status: "running",
  priority: "normal",
  requestedBy: "alice",
  createdAt: "2026-04-28T00:00:00.000Z",
};

describe("sticky-comment renderers", () => {
  test("renderQueued embeds the marker and task id", () => {
    const body = renderQueued(meta);
    assert.match(body, /<!-- omgr:task=task_abc_123 -->/);
    assert.match(body, /Task queued/);
    assert.match(body, /task_abc_123/);
    assert.match(body, /issue-initial-review/);
    assert.match(body, /@alice/);
  });

  test("renderFailure includes the error summary truncated to a code block", () => {
    const body = renderFailure(task, "boom: connection refused");
    assert.match(body, /Task failed/);
    assert.match(body, /boom: connection refused/);
    assert.match(body, /```/);
  });

  test("renderRateLimited keeps the same task marker", () => {
    const body = renderRateLimited(task);
    assert.match(body, new RegExp(stickyCommentMarker(task.taskId)));
    assert.match(body, /rate-limit/);
  });

  test("renderRejection uses the rejection marker", () => {
    const body = renderRejection(
      "PR is from a fork",
      "Cannot run `/omgr implement`: PRs from forks are not supported in v1.",
      { requestedBy: "alice", trigger: { kind: "comment", issueNumber: 52, commentId: 1 } },
    );
    assert.ok(body.includes(REJECTION_MARKER));
    assert.match(body, /Trigger rejected/);
    assert.match(body, /PR is from a fork/);
    assert.match(body, /forks are not supported/);
  });

  test("renderSuperseded names the replacing task and keeps the original sticky marker", () => {
    const task: TaskRecord = {
      taskId: "task_old",
      repo: { owner: "octo", name: "repo" },
      source: { kind: "issue", number: 7 },
      instructionId: "issue-comment-reply",
      tool: "claude",
      status: "superseded",
      priority: "normal",
      requestedBy: "alice",
      createdAt: "2026-04-30T00:00:00.000Z",
    };
    const body = renderSuperseded(task, "task_new");
    assert.ok(body.startsWith(stickyCommentMarker("task_old")));
    assert.match(body, /superseded/i);
    assert.match(body, /task_new/);
  });
});
