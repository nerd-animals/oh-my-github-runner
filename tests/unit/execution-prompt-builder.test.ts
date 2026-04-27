import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { GitHubSourceContext } from "../../src/domain/github.js";
import type { InstructionDefinition } from "../../src/domain/instruction.js";
import type { TaskRecord } from "../../src/domain/task.js";
import { ExecutionPromptBuilder } from "../../src/services/execution/execution-prompt-builder.js";

const baseTask: TaskRecord = {
  taskId: "task_1",
  repo: { owner: "octo", name: "repo" },
  source: { kind: "issue", number: 100 },
  instructionId: "issue-comment-reply",
  agent: "claude",
  status: "running",
  priority: "normal",
  requestedBy: "test",
  createdAt: "2026-04-27T00:00:00.000Z",
  startedAt: "2026-04-27T00:01:00.000Z",
};

const issueContext: GitHubSourceContext = {
  kind: "issue",
  title: "Title",
  body: "Body",
  comments: [],
};

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
  ...observeInstruction,
  id: "issue-implement",
  mode: "mutate",
  permissions: {
    codeRead: true,
    codeWrite: true,
    gitPush: true,
    prCreate: true,
    prUpdate: true,
    commentWrite: true,
  },
};

describe("ExecutionPromptBuilder", () => {
  test("observe prompts contain a Policy block forbidding workspace writes", () => {
    const prompt = new ExecutionPromptBuilder().build({
      task: baseTask,
      instruction: observeInstruction,
      context: issueContext,
    });

    assert.match(prompt, /Policy:/);
    assert.match(prompt, /- Mode: observe/);
    assert.match(prompt, /MUST NOT modify files/);
    assert.match(prompt, /git push/);
    assert.match(prompt, /gh/);
  });

  test("mutate prompts contain a Policy block allowing edits but no push", () => {
    const prompt = new ExecutionPromptBuilder().build({
      task: baseTask,
      instruction: mutateInstruction,
      context: issueContext,
    });

    assert.match(prompt, /Policy:/);
    assert.match(prompt, /- Mode: mutate/);
    assert.match(prompt, /read and write files/);
    assert.match(prompt, /runner pushes for you/);
  });
});
