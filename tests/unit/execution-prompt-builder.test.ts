import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { GitHubSourceContext } from "../../src/domain/github.js";
import type { InstructionDefinition } from "../../src/domain/instruction.js";
import type { TaskRecord } from "../../src/domain/task.js";
import { ExecutionPromptBuilder } from "../../src/domain/rules/execution-prompt.js";

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

const mutateInstruction: InstructionDefinition = {
  ...observeInstruction,
  id: "issue-implement",
  mode: "mutate",
  workflow: "mutate",
  permissions: {
    codeRead: true,
    codeWrite: true,
    gitPush: true,
    prCreate: true,
    prUpdate: true,
    commentWrite: true,
  },
};

const emptyAssets = { commonRules: "", persona: "" };

describe("ExecutionPromptBuilder", () => {
  test("observe prompts forbid workspace writes and tell the agent to post comments itself", () => {
    const prompt = new ExecutionPromptBuilder(emptyAssets).build({
      task: baseTask,
      instruction: observeInstruction,
      context: issueContext,
    });

    assert.match(prompt, /Policy:/);
    assert.match(prompt, /- Mode: observe/);
    assert.match(prompt, /MUST NOT modify files in the workspace/);
    assert.match(prompt, /gh issue comment/);
    assert.match(prompt, /runner does not write back/);
  });

  test("mutate prompts allow push and gh pr create but tell the agent not to merge", () => {
    const prompt = new ExecutionPromptBuilder(emptyAssets).build({
      task: baseTask,
      instruction: mutateInstruction,
      context: issueContext,
    });

    assert.match(prompt, /Policy:/);
    assert.match(prompt, /- Mode: mutate/);
    assert.match(prompt, /git push/);
    assert.match(prompt, /gh pr create/);
    assert.match(prompt, /server-protected/);
    assert.match(prompt, /MUST NOT merge/);
    assert.match(prompt, /gh pr merge.*blocked/);
  });

  test("prepends common rules and persona before the instruction core", () => {
    const prompt = new ExecutionPromptBuilder({
      commonRules: "# Common Work Rules\nFollow them.",
      persona: "# Architecture Persona\nReason in layers.",
    }).build({
      task: baseTask,
      instruction: observeInstruction,
      context: issueContext,
    });

    const commonIndex = prompt.indexOf("Common Work Rules");
    const personaIndex = prompt.indexOf("Architecture Persona");
    const instructionIndex = prompt.indexOf("Instruction: issue-comment-reply");

    assert.notEqual(commonIndex, -1, "common rules must appear in prompt");
    assert.notEqual(personaIndex, -1, "persona must appear in prompt");
    assert.notEqual(instructionIndex, -1, "instruction header must appear");
    assert.ok(
      commonIndex < personaIndex,
      "common rules should precede persona",
    );
    assert.ok(
      personaIndex < instructionIndex,
      "persona should precede instruction core",
    );
  });

  test("omits preamble when both common rules and persona are empty", () => {
    const prompt = new ExecutionPromptBuilder(emptyAssets).build({
      task: baseTask,
      instruction: observeInstruction,
      context: issueContext,
    });

    assert.ok(
      prompt.startsWith("Instruction: issue-comment-reply"),
      "prompt should start with instruction header when no preamble assets",
    );
  });
});
