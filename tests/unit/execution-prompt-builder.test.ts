import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { GitHubSourceContext } from "../../src/domain/github.js";
import type { InstructionDefinition } from "../../src/domain/instruction.js";
import type { TaskRecord } from "../../src/domain/task.js";
import {
  ExecutionPromptBuilder,
  type ModePolicies,
} from "../../src/domain/rules/execution-prompt.js";

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
  linkedRefs: { closes: [], bodyMentions: [] },
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

const modePolicies: ModePolicies = {
  observe: "- Mode: observe\n- READ-ONLY-MARKER",
  mutate: "- Mode: mutate\n- MUTATE-MARKER\n- PUSH-FAILURE-MARKER",
};

const emptyAssets = { commonRules: "", persona: "", modePolicies };

describe("ExecutionPromptBuilder", () => {
  test("observe prompts inject the observe mode policy under Policy:", () => {
    const prompt = new ExecutionPromptBuilder(emptyAssets).build({
      task: baseTask,
      instruction: observeInstruction,
      context: issueContext,
    });

    assert.match(prompt, /Policy:\n- Mode: observe\n- READ-ONLY-MARKER/);
    assert.ok(
      !prompt.includes("MUTATE-MARKER"),
      "observe prompt must not leak mutate policy",
    );
  });

  test("mutate prompts inject the mutate mode policy (including push-failure guidance)", () => {
    const prompt = new ExecutionPromptBuilder(emptyAssets).build({
      task: baseTask,
      instruction: mutateInstruction,
      context: issueContext,
    });

    assert.match(
      prompt,
      /Policy:\n- Mode: mutate\n- MUTATE-MARKER\n- PUSH-FAILURE-MARKER/,
    );
    assert.ok(
      !prompt.includes("READ-ONLY-MARKER"),
      "mutate prompt must not leak observe policy",
    );
  });

  test("prepends common rules and persona before the instruction core", () => {
    const prompt = new ExecutionPromptBuilder({
      commonRules: "# Common Work Rules\nFollow them.",
      persona: "# Architecture Persona\nReason in layers.",
      modePolicies,
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

  test("issue: emits 'Linked PRs (closes): - none' when there are no linked refs", () => {
    const prompt = new ExecutionPromptBuilder(emptyAssets).build({
      task: baseTask,
      instruction: observeInstruction,
      context: issueContext,
    });

    assert.match(prompt, /Linked PRs \(closes\):\n- none/);
    assert.ok(!prompt.includes("Referenced (body mentions):"));
  });

  test("issue: renders closes and body mentions with kind, state, and title", () => {
    const prompt = new ExecutionPromptBuilder(emptyAssets).build({
      task: baseTask,
      instruction: observeInstruction,
      context: {
        ...issueContext,
        linkedRefs: {
          closes: [
            {
              kind: "pull_request",
              number: 36,
              title: "webhook plan",
              state: "closed",
              merged: true,
            },
          ],
          bodyMentions: [
            {
              kind: "issue",
              number: 47,
              title: "agent-driven mode",
              state: "closed",
            },
          ],
        },
      },
    });

    assert.match(
      prompt,
      /Linked PRs \(closes\):\n- pr #36 \(merged\) — webhook plan/,
    );
    assert.match(
      prompt,
      /Referenced \(body mentions\):\n- issue #47 \(closed\) — agent-driven mode/,
    );
  });

  test("pull request: renders 'Linked Issues (closes):' and places it after Base/Head", () => {
    const prContext: GitHubSourceContext = {
      kind: "pull_request",
      title: "PR Title",
      body: "PR Body",
      comments: [],
      diff: "",
      baseRef: "main",
      headRef: "feature/x",
      linkedRefs: {
        closes: [
          { kind: "issue", number: 41, title: "include_linked_prs", state: "open" },
        ],
        bodyMentions: [],
      },
    };

    const prompt = new ExecutionPromptBuilder(emptyAssets).build({
      task: baseTask,
      instruction: { ...observeInstruction, sourceKind: "pull_request" },
      context: prContext,
    });

    const baseIndex = prompt.indexOf("Base: main");
    const linkedIndex = prompt.indexOf("Linked Issues (closes):");
    assert.notEqual(baseIndex, -1, "Base/Head block must appear");
    assert.notEqual(linkedIndex, -1, "Linked Issues section must appear");
    assert.ok(
      baseIndex < linkedIndex,
      "Linked Issues section should follow Base/Head",
    );
    assert.match(prompt, /- issue #41 \(open\) — include_linked_prs/);
  });
});
