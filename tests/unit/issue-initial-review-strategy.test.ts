import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { GitHubSourceContext } from "../../src/domain/github.js";
import type { TaskRecord } from "../../src/domain/task.js";
import { issueInitialReviewStrategy } from "../../src/strategies/issue-initial-review/index.js";
import { TOOL_MAP } from "../../src/strategies/issue-initial-review/persona-tool-map.js";
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
  tool: "claude",
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
  /** Per-persona-id result map. ai.run picks the result by the persona fragment in the prompt. */
  resultsByPersona: Record<string, AiRunResult>;
}): {
  tk: Toolkit;
  aiCalls: AiRunOptions[];
  postedIssueComments: Array<{ issueNumber: number; body: string }>;
  postedPrComments: Array<{ prNumber: number; body: string }>;
} {
  const aiCalls: AiRunOptions[] = [];
  const postedIssueComments: Array<{ issueNumber: number; body: string }> = [];
  const postedPrComments: Array<{ prNumber: number; body: string }> = [];

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
        const personaFragment = opts.prompt.find(
          (frag) => frag.kind === "file" && frag.path.startsWith("personas/"),
        );
        const personaId =
          personaFragment?.kind === "file"
            ? personaFragment.path.replace("personas/", "")
            : null;
        if (personaId === null) {
          throw new Error("ai.run called without a persona fragment");
        }
        const result = options.resultsByPersona[personaId];
        if (result === undefined) {
          throw new Error(`no scripted result for persona '${personaId}'`);
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

describe("issueInitialReviewStrategy (parallel multi-persona collect-only)", () => {
  test("runs all four personas with COLLECT_ONLY preset and persona-mapped tool", async () => {
    const { tk, aiCalls, postedIssueComments } = makeToolkit({
      resultsByPersona: {
        architect: { kind: "succeeded", stdout: "architect findings" },
        test: { kind: "succeeded", stdout: "test findings" },
        ops: { kind: "succeeded", stdout: "ops findings" },
        maintenance: { kind: "succeeded", stdout: "maintenance findings" },
      },
    });

    const result = await issueInitialReviewStrategy.run(
      task,
      tk,
      new AbortController().signal,
    );

    assert.deepEqual(result, { status: "succeeded" });
    assert.equal(aiCalls.length, 4);

    // Order is not guaranteed under Promise.all, so assert as a set.
    const personaPaths = new Set(
      aiCalls
        .map((call) => {
          const frag = call.prompt.find(
            (f) => f.kind === "file" && f.path.startsWith("personas/"),
          );
          return frag?.kind === "file" ? frag.path : "?";
        })
        .filter((p) => p !== "?"),
    );
    assert.deepEqual(
      personaPaths,
      new Set([
        "personas/architect",
        "personas/test",
        "personas/ops",
        "personas/maintenance",
      ]),
    );

    // Each persona must use its mapped tool.
    for (const call of aiCalls) {
      const frag = call.prompt.find(
        (f) => f.kind === "file" && f.path.startsWith("personas/"),
      );
      const personaId =
        frag?.kind === "file" ? frag.path.replace("personas/", "") : null;
      assert.ok(personaId, "every call must reference a persona fragment");
      assert.equal(
        call.tool,
        TOOL_MAP[personaId as keyof typeof TOOL_MAP],
        `persona '${personaId}' should use mapped tool '${TOOL_MAP[personaId as keyof typeof TOOL_MAP]}'`,
      );
      assert.equal(call.allowedTools, COLLECT_ONLY_ALLOWED);
      assert.equal(call.disallowedTools, COLLECT_ONLY_DISALLOWED);
      const collectOnlyFragment = call.prompt.find(
        (f) => f.kind === "file" && f.path === "modes/collect-only",
      );
      assert.ok(
        collectOnlyFragment,
        "every persona invocation must include the collect-only mode fragment",
      );
    }

    assert.equal(postedIssueComments.length, 1);
    const posted = postedIssueComments[0]!;
    assert.equal(posted.issueNumber, 7);
    assert.match(posted.body, /Architect 관점/);
    assert.match(posted.body, /Test 관점/);
    assert.match(posted.body, /Ops 관점/);
    assert.match(posted.body, /Maintenance 관점/);
    assert.match(posted.body, /architect findings/);
    assert.match(posted.body, /maintenance findings/);
  });

  test("returns rate_limited when any persona is rate_limited (queue retries the whole task)", async () => {
    const { tk, postedIssueComments } = makeToolkit({
      resultsByPersona: {
        architect: { kind: "succeeded", stdout: "architect findings" },
        test: { kind: "succeeded", stdout: "test findings" },
        ops: { kind: "rate_limited", toolName: "gemini" },
        maintenance: { kind: "succeeded", stdout: "maintenance findings" },
      },
    });

    const result = await issueInitialReviewStrategy.run(
      task,
      tk,
      new AbortController().signal,
    );

    assert.equal(result.status, "rate_limited");
    if (result.status !== "rate_limited") return;
    assert.equal(result.toolName, "gemini");
    assert.equal(postedIssueComments.length, 0);
  });

  test("rate_limited wins over failed when both are present", async () => {
    const { tk, postedIssueComments } = makeToolkit({
      resultsByPersona: {
        architect: { kind: "succeeded", stdout: "architect findings" },
        test: { kind: "failed", errorSummary: "codex crashed" },
        ops: { kind: "rate_limited", toolName: "gemini" },
        maintenance: { kind: "succeeded", stdout: "maintenance findings" },
      },
    });

    const result = await issueInitialReviewStrategy.run(
      task,
      tk,
      new AbortController().signal,
    );

    assert.equal(result.status, "rate_limited");
    if (result.status !== "rate_limited") return;
    assert.equal(result.toolName, "gemini");
    assert.equal(postedIssueComments.length, 0);
  });

  test("returns failed when any persona fails and none are rate_limited", async () => {
    const { tk, postedIssueComments } = makeToolkit({
      resultsByPersona: {
        architect: { kind: "succeeded", stdout: "architect findings" },
        test: { kind: "succeeded", stdout: "test findings" },
        ops: { kind: "failed", errorSummary: "ops explorer crashed" },
        maintenance: { kind: "succeeded", stdout: "maintenance findings" },
      },
    });

    const result = await issueInitialReviewStrategy.run(
      task,
      tk,
      new AbortController().signal,
    );

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.match(result.errorSummary, /ops explorer crashed/);
    assert.equal(postedIssueComments.length, 0);
  });

  test("respects an aborted signal at strategy entry", async () => {
    const ac = new AbortController();
    ac.abort();
    const { tk, aiCalls, postedIssueComments } = makeToolkit({
      resultsByPersona: {
        architect: { kind: "succeeded", stdout: "architect findings" },
        test: { kind: "succeeded", stdout: "test findings" },
        ops: { kind: "succeeded", stdout: "ops findings" },
        maintenance: { kind: "succeeded", stdout: "maintenance findings" },
      },
    });

    await assert.rejects(
      issueInitialReviewStrategy.run(task, tk, ac.signal),
      /aborted|abort/i,
    );
    assert.equal(aiCalls.length, 0);
    assert.equal(postedIssueComments.length, 0);
  });
});
