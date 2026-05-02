import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { GitHubSourceContext } from "../../src/domain/github.js";
import type { TaskRecord } from "../../src/domain/task.js";
import { issueCommentReplyStrategy } from "../../src/strategies/issue-comment-reply.js";
import {
  OBSERVE_ALLOWED,
  REPLY_DISALLOWED,
} from "../../src/strategies/_shared/tool-presets.js";
import type {
  AiRunOptions,
  AiRunResult,
  DisposableMutateWorkspace,
  DisposableWorkspace,
  Toolkit,
} from "../../src/strategies/types.js";

const task: TaskRecord = {
  taskId: "task_reply_1",
  repo: { owner: "octo", name: "repo" },
  source: { kind: "issue", number: 42 },
  instructionId: "issue-comment-reply",
  status: "running",
  priority: "normal",
  requestedBy: "alice",
  createdAt: "2026-04-30T00:00:00.000Z",
};

const issueContext: GitHubSourceContext = {
  kind: "issue",
  title: "How should we structure the new module?",
  body: "Question body…",
  comments: [{ author: "alice", body: "follow-up question" }],
  linkedRefs: { closes: [], bodyMentions: [] },
};

function makeToolkit(replyResult: AiRunResult): {
  tk: Toolkit;
  aiCalls: AiRunOptions[];
  postedIssueComments: Array<{ issueNumber: number; body: string }>;
} {
  const aiCalls: AiRunOptions[] = [];
  const postedIssueComments: Array<{ issueNumber: number; body: string }> = [];

  const observeWs: DisposableWorkspace = {
    path: "/tmp/observe",
    installationToken: "ghs_TEST",
    [Symbol.asyncDispose]: async () => {},
  };
  const mutateWs: DisposableMutateWorkspace = {
    ...observeWs,
    branchName: "ai/issue-42-test",
    baseBranch: "main",
    [Symbol.asyncDispose]: async () => {},
  };

  const tk: Toolkit = {
    github: {
      fetchContext: async () => issueContext,
      getDefaultBranch: async () => "main",
      postIssueComment: async (_repo, issueNumber, body) => {
        postedIssueComments.push({ issueNumber, body });
      },
      postPrComment: async () => {},
    },
    workspace: {
      prepareObserve: async () => observeWs,
      prepareMutate: async () => mutateWs,
      preparePrImplement: async () => mutateWs,
    },
    ai: {
      run: async (opts) => {
        aiCalls.push(opts);
        return replyResult;
      },
    },
    log: {
      write: async () => {},
    },
  };
  return { tk, aiCalls, postedIssueComments };
}

describe("issueCommentReplyStrategy", () => {
  test("declares codex as the only tool in policies.uses", () => {
    assert.deepEqual(issueCommentReplyStrategy.policies.uses, { codex: true });
    assert.equal(issueCommentReplyStrategy.policies.supersedeOnSameSource, true);
  });

  test("invokes ai.run exactly once with the reply persona, observe mode, and observe-allowed + reply-disallowed", async () => {
    const { tk, aiCalls, postedIssueComments } = makeToolkit({
      kind: "succeeded",
      stdout: "직답: ...",
    });

    const result = await issueCommentReplyStrategy.run(
      task,
      tk,
      new AbortController().signal,
    );

    assert.deepEqual(result, { status: "succeeded" });
    assert.equal(aiCalls.length, 1);

    const call = aiCalls[0]!;
    // tool override is omitted because policies.uses is single-tool; the
    // toolkit infers codex from the declared set.
    assert.equal(call.tool, undefined);
    assert.equal(call.allowedTools, OBSERVE_ALLOWED);
    assert.equal(call.disallowedTools, REPLY_DISALLOWED);

    // Reply persona is wired in; the old architect persona is not.
    const personaPaths = call.prompt
      .filter((f) => f.kind === "file" && f.path.startsWith("personas/"))
      .map((f) => (f.kind === "file" ? f.path : ""));
    assert.deepEqual(personaPaths, ["personas/reply"]);
    assert.ok(
      !personaPaths.includes("personas/architect"),
      "architect persona must not appear in reply prompt",
    );

    // Observe mode is preserved (option-2 contract: AI posts the reply itself).
    assert.ok(
      call.prompt.some((f) => f.kind === "file" && f.path === "modes/observe"),
      "observe mode prompt must be present",
    );

    // Strategy must not post via runner; AI is responsible for `gh issue comment`.
    assert.equal(postedIssueComments.length, 0);
  });

  test("disallowedTools blocks code-mutating gh subcommands and git push", () => {
    assert.ok(REPLY_DISALLOWED.includes("shell:gh pr merge"));
    assert.ok(REPLY_DISALLOWED.includes("shell:gh repo edit"));
    assert.ok(REPLY_DISALLOWED.includes("shell:gh repo delete"));
    assert.ok(REPLY_DISALLOWED.includes("shell:gh release create"));
    assert.ok(REPLY_DISALLOWED.includes("shell:gh release delete"));
    assert.ok(REPLY_DISALLOWED.includes("shell:gh ruleset"));
    assert.ok(REPLY_DISALLOWED.includes("shell:gh workflow"));
    assert.ok(REPLY_DISALLOWED.includes("shell:git push"));
  });

  test("forwards rate_limited from ai.run with toolName preserved", async () => {
    const { tk, postedIssueComments } = makeToolkit({
      kind: "rate_limited",
      toolName: "codex",
    });

    const result = await issueCommentReplyStrategy.run(
      task,
      tk,
      new AbortController().signal,
    );

    assert.equal(result.status, "rate_limited");
    if (result.status !== "rate_limited") return;
    assert.equal(result.toolName, "codex");
    assert.equal(postedIssueComments.length, 0);
  });

  test("forwards failed from ai.run with errorSummary preserved", async () => {
    const { tk, postedIssueComments } = makeToolkit({
      kind: "failed",
      errorSummary: "codex crashed",
    });

    const result = await issueCommentReplyStrategy.run(
      task,
      tk,
      new AbortController().signal,
    );

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.match(result.errorSummary, /codex crashed/);
    assert.equal(postedIssueComments.length, 0);
  });

  test("respects an aborted signal at strategy entry", async () => {
    const ac = new AbortController();
    ac.abort();
    const { tk, aiCalls } = makeToolkit({ kind: "succeeded", stdout: "x" });

    await assert.rejects(
      issueCommentReplyStrategy.run(task, tk, ac.signal),
      /aborted|abort/i,
    );
    assert.equal(aiCalls.length, 0);
  });
});
