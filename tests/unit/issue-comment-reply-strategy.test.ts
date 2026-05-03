import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { GitHubSourceContext } from "../../src/domain/github.js";
import type { RepoRef, TaskRecord } from "../../src/domain/task.js";
import { issueCommentReplyStrategy } from "../../src/strategies/issue-comment-reply.js";
import { COLLECT_ONLY_ALLOWED } from "../../src/strategies/_shared/tool-presets.js";
import { ISSUE_COMMENT_REPLY_OUTPUT_SCHEMA } from "../../src/strategies/_shared/reply-actions.js";
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
  body: "Question body",
  comments: [{ author: "alice", body: "follow-up question" }],
  linkedRefs: { closes: [], bodyMentions: [] },
};

interface IssueCommentCall {
  issueNumber: number;
  body: string;
}

interface PrCommentCall {
  prNumber: number;
  body: string;
}

interface CreateIssueCall {
  title: string;
  body: string;
}

function makeToolkit(options: {
  replyResult: AiRunResult;
  createIssueResult?: { number: number; url: string };
  createIssueError?: Error;
  closeIssueError?: Error;
  issueCommentError?: Error;
  prCommentError?: Error;
}): {
  tk: Toolkit;
  aiCalls: AiRunOptions[];
  postedIssueComments: IssueCommentCall[];
  postedPrComments: PrCommentCall[];
  createdIssues: CreateIssueCall[];
  closedIssues: number[];
} {
  const aiCalls: AiRunOptions[] = [];
  const postedIssueComments: IssueCommentCall[] = [];
  const postedPrComments: PrCommentCall[] = [];
  const createdIssues: CreateIssueCall[] = [];
  const closedIssues: number[] = [];

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
        if (options.issueCommentError !== undefined) {
          throw options.issueCommentError;
        }
        postedIssueComments.push({ issueNumber, body });
      },
      postPrComment: async (_repo, prNumber, body) => {
        if (options.prCommentError !== undefined) {
          throw options.prCommentError;
        }
        postedPrComments.push({ prNumber, body });
      },
      createIssue: async (_repo, title, body) => {
        if (options.createIssueError !== undefined) {
          throw options.createIssueError;
        }
        createdIssues.push({ title, body });
        return options.createIssueResult ?? {
          number: 501,
          url: "https://github.com/octo/repo/issues/501",
        };
      },
      closeIssue: async (_repo, issueNumber) => {
        if (options.closeIssueError !== undefined) {
          throw options.closeIssueError;
        }
        closedIssues.push(issueNumber);
      },
    },
    workspace: {
      prepareObserve: async () => observeWs,
      prepareMutate: async () => mutateWs,
      preparePrImplement: async () => mutateWs,
    },
    ai: {
      run: async (opts) => {
        aiCalls.push(opts);
        return options.replyResult;
      },
    },
    log: {
      write: async () => {},
    },
  };

  return {
    tk,
    aiCalls,
    postedIssueComments,
    postedPrComments,
    createdIssues,
    closedIssues,
  };
}

function replyEnvelope(payload?: {
  replyComment?: string;
  reasoning?: string;
  additionalActions?: readonly object[];
}): string {
  return JSON.stringify({
    replyComment: payload?.replyComment ?? "Here is the answer.",
    reasoning: payload?.reasoning ?? "This is the most direct response.",
    additionalActions: payload?.additionalActions ?? [],
  });
}

describe("issueCommentReplyStrategy", () => {
  test("declares codex as the only tool in policies.uses", () => {
    assert.deepEqual(issueCommentReplyStrategy.policies.uses, { codex: true });
    assert.equal(issueCommentReplyStrategy.policies.supersedeOnSameSource, true);
  });

  test("invokes ai.run with the reply persona, structured reply mode, collect-only permissions, and the output schema", async () => {
    const { tk, aiCalls, postedIssueComments, createdIssues, closedIssues } =
      makeToolkit({
        replyResult: {
          kind: "succeeded",
          stdout: replyEnvelope(),
        },
      });

    const result = await issueCommentReplyStrategy.run(
      task,
      tk,
      new AbortController().signal,
    );

    assert.deepEqual(result, { status: "succeeded" });
    assert.equal(aiCalls.length, 1);

    const call = aiCalls[0]!;
    assert.equal(call.tool, undefined);
    assert.equal(call.allowedTools, COLLECT_ONLY_ALLOWED);
    assert.deepEqual(call.outputSchema, ISSUE_COMMENT_REPLY_OUTPUT_SCHEMA);

    const personaPaths = call.prompt
      .filter((f) => f.kind === "file" && f.path.startsWith("personas/"))
      .map((f) => (f.kind === "file" ? f.path : ""));
    assert.deepEqual(personaPaths, ["personas/reply"]);
    assert.ok(
      call.prompt.some(
        (f) => f.kind === "file" && f.path === "modes/reply-structured",
      ),
      "structured reply mode prompt must be present",
    );
    assert.ok(
      !call.prompt.some((f) => f.kind === "file" && f.path === "modes/observe"),
      "observe mode must not be present",
    );

    assert.deepEqual(createdIssues, []);
    assert.deepEqual(closedIssues, []);
    assert.deepEqual(postedIssueComments, [
      { issueNumber: 42, body: "Here is the answer." },
    ]);
  });

  test("executes create_issue, close_issue, and comment actions and appends receipts to the source reply", async () => {
    const { tk, postedIssueComments, postedPrComments, createdIssues, closedIssues } =
      makeToolkit({
        replyResult: {
          kind: "succeeded",
          stdout: replyEnvelope({
            replyComment: "Completed the follow-up actions.",
            additionalActions: [
              {
                kind: "create_issue",
                title: "Follow-up: capture edge cases",
                body: "Track the uncovered edge cases here.",
              },
              { kind: "close_issue", issueNumber: 77 },
              {
                kind: "comment",
                targetKind: "pull_request",
                targetNumber: 88,
                body: "Please see the linked issue for the next step.",
              },
            ],
          }),
        },
      });

    const result = await issueCommentReplyStrategy.run(
      task,
      tk,
      new AbortController().signal,
    );

    assert.deepEqual(result, { status: "succeeded" });
    assert.deepEqual(createdIssues, [
      {
        title: "Follow-up: capture edge cases",
        body: "Track the uncovered edge cases here.",
      },
    ]);
    assert.deepEqual(closedIssues, [77]);
    assert.deepEqual(postedPrComments, [
      {
        prNumber: 88,
        body: "Please see the linked issue for the next step.",
      },
    ]);
    assert.equal(postedIssueComments.length, 1);
    const finalReply = postedIssueComments[0]!;
    assert.equal(finalReply.issueNumber, 42);
    assert.match(finalReply.body, /Completed the follow-up actions\./);
    assert.match(finalReply.body, /Opened follow-up issue #501/);
    assert.match(finalReply.body, /Closed issue #77/);
    assert.match(finalReply.body, /Commented on pull request #88/);
  });

  test("rejects an empty replyComment", async () => {
    const { tk, postedIssueComments } = makeToolkit({
      replyResult: {
        kind: "succeeded",
        stdout: replyEnvelope({ replyComment: "   " }),
      },
    });

    const result = await issueCommentReplyStrategy.run(
      task,
      tk,
      new AbortController().signal,
    );

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.match(result.errorSummary, /replyComment/i);
    assert.equal(postedIssueComments.length, 0);
  });

  test("rejects additionalActions.comment when it targets the source issue", async () => {
    const { tk, postedIssueComments, postedPrComments } = makeToolkit({
      replyResult: {
        kind: "succeeded",
        stdout: replyEnvelope({
          additionalActions: [
            {
              kind: "comment",
              targetKind: "issue",
              targetNumber: 42,
              body: "This should be rejected.",
            },
          ],
        }),
      },
    });

    const result = await issueCommentReplyStrategy.run(
      task,
      tk,
      new AbortController().signal,
    );

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.match(result.errorSummary, /source issue/i);
    assert.equal(postedIssueComments.length, 0);
    assert.equal(postedPrComments.length, 0);
  });

  test("reports malformed JSON as a failure", async () => {
    const { tk, postedIssueComments } = makeToolkit({
      replyResult: {
        kind: "succeeded",
        stdout: "{not valid json",
      },
    });

    const result = await issueCommentReplyStrategy.run(
      task,
      tk,
      new AbortController().signal,
    );

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.match(result.errorSummary, /parse/i);
    assert.equal(postedIssueComments.length, 0);
  });

  test("continues after an additional action fails and includes the failure receipt in the source reply", async () => {
    const { tk, postedIssueComments, createdIssues } = makeToolkit({
      closeIssueError: new Error("permission denied"),
      replyResult: {
        kind: "succeeded",
        stdout: replyEnvelope({
          replyComment: "I tried both actions.",
          additionalActions: [
            { kind: "close_issue", issueNumber: 77 },
            {
              kind: "create_issue",
              title: "Fallback tracking issue",
              body: "Used because closing failed.",
            },
          ],
        }),
      },
    });

    const result = await issueCommentReplyStrategy.run(
      task,
      tk,
      new AbortController().signal,
    );

    assert.deepEqual(result, { status: "succeeded" });
    assert.deepEqual(createdIssues, [
      {
        title: "Fallback tracking issue",
        body: "Used because closing failed.",
      },
    ]);
    assert.equal(postedIssueComments.length, 1);
    assert.match(postedIssueComments[0]!.body, /Failed to close issue #77/);
    assert.match(postedIssueComments[0]!.body, /permission denied/);
    assert.match(postedIssueComments[0]!.body, /Opened follow-up issue #501/);
  });

  test("forwards rate_limited from ai.run with toolName preserved", async () => {
    const { tk, postedIssueComments } = makeToolkit({
      replyResult: {
        kind: "rate_limited",
        toolName: "codex",
      },
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
      replyResult: {
        kind: "failed",
        errorSummary: "codex crashed",
      },
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
    const { tk, aiCalls } = makeToolkit({
      replyResult: {
        kind: "succeeded",
        stdout: replyEnvelope(),
      },
    });

    await assert.rejects(
      issueCommentReplyStrategy.run(task, tk, ac.signal),
      /aborted|abort/i,
    );
    assert.equal(aiCalls.length, 0);
  });
});
