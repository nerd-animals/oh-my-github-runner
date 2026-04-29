import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { GitHubSourceContext } from "../../src/domain/github.js";
import type { TaskRecord } from "../../src/domain/task.js";
import { issueInitialReviewStrategy } from "../../src/strategies/issue-initial-review.js";
import {
  COLLECT_ONLY_ALLOWED,
  COLLECT_ONLY_DISALLOWED,
} from "../../src/strategies/_shared/tool-presets.js";
import type {
  AiRunOptions,
  AiRunResult,
  DisposableMutateWorkspace,
  DisposableWorkspace,
  Toolkit,
} from "../../src/strategies/types.js";

const task: TaskRecord = {
  taskId: "task_review_1",
  repo: { owner: "octo", name: "repo" },
  source: { kind: "issue", number: 7 },
  instructionId: "issue-initial-review",
  agent: "claude",
  status: "running",
  priority: "normal",
  requestedBy: "alice",
  createdAt: "2026-04-30T00:00:00.000Z",
};

const issueContext: GitHubSourceContext = {
  kind: "issue",
  title: "Add caching to the public API",
  body: "We're hitting rate limits…",
  comments: [],
  linkedRefs: { closes: [], bodyMentions: [] },
};

function makeToolkit(options: {
  aiResults: ReadonlyArray<AiRunResult>;
}): {
  tk: Toolkit;
  aiCalls: AiRunOptions[];
  postedIssueComments: Array<{ issueNumber: number; body: string }>;
  postedPrComments: Array<{ prNumber: number; body: string }>;
} {
  const aiCalls: AiRunOptions[] = [];
  const postedIssueComments: Array<{ issueNumber: number; body: string }> = [];
  const postedPrComments: Array<{ prNumber: number; body: string }> = [];
  let resultIdx = 0;

  const observeWs: DisposableWorkspace = {
    path: "/tmp/observe",
    installationToken: "ghs_TEST",
    [Symbol.asyncDispose]: async () => {},
  };
  const mutateWs: DisposableMutateWorkspace = {
    ...observeWs,
    branchName: "ai/issue-7-test",
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
      postPrComment: async (_repo, prNumber, body) => {
        postedPrComments.push({ prNumber, body });
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
        const result = options.aiResults[resultIdx];
        resultIdx += 1;
        if (result === undefined) {
          throw new Error(`ai.run called more times than expected: ${resultIdx}`);
        }
        return result;
      },
    },
    log: {
      write: async () => {},
    },
  };
  return { tk, aiCalls, postedIssueComments, postedPrComments };
}

describe("issueInitialReviewStrategy (multi-persona collect-only)", () => {
  test("calls ai.run once per persona in order, each with COLLECT_ONLY tool preset", async () => {
    const aiResults: AiRunResult[] = [
      { kind: "succeeded", stdout: "arch findings" },
      { kind: "succeeded", stdout: "impl findings" },
      { kind: "succeeded", stdout: "infra findings" },
      { kind: "succeeded", stdout: "product findings" },
      { kind: "succeeded", stdout: "testing findings" },
    ];
    const { tk, aiCalls, postedIssueComments } = makeToolkit({ aiResults });

    const result = await issueInitialReviewStrategy.run(
      task,
      tk,
      new AbortController().signal,
    );

    assert.deepEqual(result, { status: "succeeded" });
    assert.equal(aiCalls.length, 5);

    const personaOrder = aiCalls.map((call) => {
      const personaFragment = call.prompt.find(
        (frag) => frag.kind === "file" && frag.path.startsWith("personas/"),
      );
      return personaFragment?.kind === "file" ? personaFragment.path : "?";
    });
    assert.deepEqual(personaOrder, [
      "personas/architecture",
      "personas/implementation",
      "personas/infra",
      "personas/product",
      "personas/testing",
    ]);

    for (const call of aiCalls) {
      assert.equal(call.allowedTools, COLLECT_ONLY_ALLOWED);
      assert.equal(call.disallowedTools, COLLECT_ONLY_DISALLOWED);
      const collectOnlyFragment = call.prompt.find(
        (frag) =>
          frag.kind === "file" && frag.path === "modes/collect-only",
      );
      assert.ok(
        collectOnlyFragment,
        "every persona invocation must include the collect-only mode fragment",
      );
    }

    assert.equal(postedIssueComments.length, 1);
    const posted = postedIssueComments[0]!;
    assert.equal(posted.issueNumber, 7);
    assert.match(posted.body, /Architecture 관점/);
    assert.match(posted.body, /Implementation 관점/);
    assert.match(posted.body, /Infra 관점/);
    assert.match(posted.body, /Product 관점/);
    assert.match(posted.body, /Testing 관점/);
    assert.match(posted.body, /arch findings/);
    assert.match(posted.body, /testing findings/);
  });

  test("aborts and returns failed when a persona run errors out, posts no comment", async () => {
    const aiResults: AiRunResult[] = [
      { kind: "succeeded", stdout: "arch findings" },
      { kind: "succeeded", stdout: "impl findings" },
      { kind: "failed", errorSummary: "infra explorer crashed" },
    ];
    const { tk, aiCalls, postedIssueComments } = makeToolkit({ aiResults });

    const result = await issueInitialReviewStrategy.run(
      task,
      tk,
      new AbortController().signal,
    );

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.match(result.errorSummary, /infra explorer crashed/);
    assert.equal(aiCalls.length, 3);
    assert.equal(postedIssueComments.length, 0);
  });

  test("respects an externally aborted signal before launching the next persona", async () => {
    const ac = new AbortController();
    let count = 0;
    const aiResults: AiRunResult[] = [
      { kind: "succeeded", stdout: "arch" },
      { kind: "succeeded", stdout: "impl" },
    ];
    const { tk } = makeToolkit({ aiResults });
    // Wrap ai.run so it aborts after the second call.
    const originalRun = tk.ai.run.bind(tk.ai);
    tk.ai.run = async (opts) => {
      const r = await originalRun(opts);
      count += 1;
      if (count === 2) {
        ac.abort();
      }
      return r;
    };

    await assert.rejects(
      issueInitialReviewStrategy.run(task, tk, ac.signal),
      /aborted|abort/i,
    );
  });
});
