import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { GitHubSourceContext } from "../../src/domain/github.js";
import type { TaskRecord } from "../../src/domain/task.js";
import { issueInitialReviewStrategy } from "../../src/strategies/issue-initial-review/index.js";
import { TOOL_MAP } from "../../src/strategies/issue-initial-review/persona-tool-map.js";
import { COLLECT_ONLY_ALLOWED } from "../../src/strategies/_shared/tool-presets.js";
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

/**
 * The strategy issues 5 calls to ai.run: 4 personas (architect/test/ops/maintenance)
 * + 1 publisher. The mock routes by the persona fragment in the prompt, so order
 * does not matter (Promise.all).
 *
 * `publisherResult` defaults to a succeeded synthesis so existing scripts can stay
 * focused on the persona phase.
 */
function makeToolkit(options: {
  resultsByPersona: Record<string, AiRunResult>;
  publisherResult?: AiRunResult;
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

  const publisherDefault: AiRunResult = {
    kind: "succeeded",
    stdout: "## 한 줄 요약\n캐시 도입 검토 필요.\n",
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
        if (personaId === "publisher") {
          return options.publisherResult ?? publisherDefault;
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

const ALL_SUCCEEDED: Record<string, AiRunResult> = {
  architect: { kind: "succeeded", stdout: "architect findings" },
  test: { kind: "succeeded", stdout: "test findings" },
  ops: { kind: "succeeded", stdout: "ops findings" },
  maintenance: { kind: "succeeded", stdout: "maintenance findings" },
};

describe("issueInitialReviewStrategy (parallel personas + publisher)", () => {
  test("declares both tools in policies.uses so the daemon waits for all to be rate-limit-clear", () => {
    assert.deepEqual(issueInitialReviewStrategy.policies.uses, {
      claude: true,
      codex: true,
    });
  });

  test("runs all four personas with COLLECT_ONLY preset and persona-mapped tool", async () => {
    const { tk, aiCalls, postedIssueComments } = makeToolkit({
      resultsByPersona: ALL_SUCCEEDED,
    });

    const result = await issueInitialReviewStrategy.run(
      task,
      tk,
      new AbortController().signal,
    );

    assert.deepEqual(result, { status: "succeeded" });
    // 4 personas + 1 publisher.
    assert.equal(aiCalls.length, 5);

    const personaCalls = aiCalls.filter((call) => {
      const frag = call.prompt.find(
        (f) => f.kind === "file" && f.path.startsWith("personas/"),
      );
      if (frag?.kind !== "file") return false;
      return frag.path !== "personas/publisher";
    });
    assert.equal(personaCalls.length, 4);

    const personaPaths = new Set(
      personaCalls.map((call) => {
        const frag = call.prompt.find(
          (f) => f.kind === "file" && f.path.startsWith("personas/"),
        );
        return frag?.kind === "file" ? frag.path : "?";
      }),
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

    for (const call of personaCalls) {
      const frag = call.prompt.find(
        (f) => f.kind === "file" && f.path.startsWith("personas/"),
      );
      const personaId =
        frag?.kind === "file" ? frag.path.replace("personas/", "") : null;
      assert.ok(personaId);
      assert.equal(
        call.tool,
        TOOL_MAP[personaId as keyof typeof TOOL_MAP],
        `persona '${personaId}' should use mapped tool`,
      );
      assert.equal(call.allowedTools, COLLECT_ONLY_ALLOWED);
    }

    assert.equal(postedIssueComments.length, 1);
    const posted = postedIssueComments[0]!;
    assert.equal(posted.issueNumber, 7);
    // Synthesis at top.
    assert.match(posted.body, /한 줄 요약/);
    assert.match(posted.body, /캐시 도입 검토 필요/);
    // Appendix with collapsible details and tool labels.
    assert.match(posted.body, /<details><summary>Architect 관점 \(claude\)<\/summary>/);
    assert.match(posted.body, /<details><summary>Test 관점 \(codex\)<\/summary>/);
    assert.match(posted.body, /<details><summary>Ops 관점 \(codex\)<\/summary>/);
    assert.match(posted.body, /<details><summary>Maintenance 관점 \(codex\)<\/summary>/);
    assert.match(posted.body, /architect findings/);
    assert.match(posted.body, /maintenance findings/);
  });

  test("publisher runs with codex tool", async () => {
    const { tk, aiCalls } = makeToolkit({ resultsByPersona: ALL_SUCCEEDED });

    await issueInitialReviewStrategy.run(
      task,
      tk,
      new AbortController().signal,
    );

    const publisherCall = aiCalls.find((call) =>
      call.prompt.some(
        (f) => f.kind === "file" && f.path === "personas/publisher",
      ),
    );
    assert.ok(publisherCall, "publisher must be invoked");
    assert.equal(publisherCall.tool, "codex");
  });

  test("each persona prompt includes its mapped .omgr doc; publisher has none", async () => {
    const { tk, aiCalls } = makeToolkit({ resultsByPersona: ALL_SUCCEEDED });

    await issueInitialReviewStrategy.run(
      task,
      tk,
      new AbortController().signal,
    );

    const expectedByPersona: Record<string, string> = {
      architect: ".omgr/architecture.md",
      test: ".omgr/testing.md",
      ops: ".omgr/deployment.md",
      maintenance: ".omgr/architecture.md",
    };

    for (const call of aiCalls) {
      const personaFrag = call.prompt.find(
        (f) => f.kind === "file" && f.path.startsWith("personas/"),
      );
      assert.ok(personaFrag && personaFrag.kind === "file");
      const personaId = personaFrag.path.replace("personas/", "");

      const omgrDocs = call.prompt.filter((f) => f.kind === "omgr-doc");

      if (personaId === "publisher") {
        assert.equal(
          omgrDocs.length,
          0,
          "publisher prompt must not include any omgr-doc fragment",
        );
        continue;
      }

      const expected = expectedByPersona[personaId];
      assert.ok(expected, `unexpected persona '${personaId}'`);
      assert.equal(
        omgrDocs.length,
        1,
        `persona '${personaId}' should have exactly one omgr-doc fragment`,
      );
      assert.equal(
        omgrDocs[0]?.kind === "omgr-doc" ? omgrDocs[0].path : null,
        expected,
        `persona '${personaId}' should map to ${expected}`,
      );
    }
  });

  test("publisher rate_limited → fallback comment with appendix only", async () => {
    const { tk, aiCalls, postedIssueComments } = makeToolkit({
      resultsByPersona: ALL_SUCCEEDED,
      publisherResult: { kind: "rate_limited", toolName: "codex" },
    });

    const result = await issueInitialReviewStrategy.run(
      task,
      tk,
      new AbortController().signal,
    );

    assert.deepEqual(result, { status: "succeeded" });
    assert.equal(aiCalls.length, 5);
    assert.equal(postedIssueComments.length, 1);
    const body = postedIssueComments[0]!.body;
    assert.match(body, /통합 요약 생성에 실패했습니다/);
    assert.match(body, /publisher \(codex\) rate-limited/);
    assert.match(body, /<details><summary>Architect 관점/);
    assert.match(body, /<details><summary>Maintenance 관점/);
    assert.doesNotMatch(body, /캐시 도입 검토 필요/); // synthesis must not appear
  });

  test("publisher failed → fallback comment with appendix only", async () => {
    const { tk, postedIssueComments } = makeToolkit({
      resultsByPersona: ALL_SUCCEEDED,
      publisherResult: { kind: "failed", errorSummary: "codex boom" },
    });

    const result = await issueInitialReviewStrategy.run(
      task,
      tk,
      new AbortController().signal,
    );

    assert.deepEqual(result, { status: "succeeded" });
    const body = postedIssueComments[0]!.body;
    assert.match(body, /통합 요약 생성에 실패했습니다/);
    assert.match(body, /codex boom/);
    assert.match(body, /<details><summary>Architect 관점/);
  });

  test("returns rate_limited when any persona is rate_limited (publisher does not run)", async () => {
    const { tk, aiCalls, postedIssueComments } = makeToolkit({
      resultsByPersona: {
        architect: { kind: "succeeded", stdout: "architect findings" },
        test: { kind: "succeeded", stdout: "test findings" },
        ops: { kind: "rate_limited", toolName: "codex" },
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
    assert.equal(result.toolName, "codex");
    // Only personas ran; publisher must not have been invoked.
    assert.equal(aiCalls.length, 4);
    assert.equal(postedIssueComments.length, 0);
  });

  test("rate_limited wins over failed when both are present in personas", async () => {
    const { tk, postedIssueComments } = makeToolkit({
      resultsByPersona: {
        architect: { kind: "succeeded", stdout: "architect findings" },
        test: { kind: "failed", errorSummary: "codex crashed" },
        ops: { kind: "rate_limited", toolName: "codex" },
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
    assert.equal(result.toolName, "codex");
    assert.equal(postedIssueComments.length, 0);
  });

  test("returns failed when any persona fails and none are rate_limited", async () => {
    const { tk, aiCalls, postedIssueComments } = makeToolkit({
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
    assert.equal(aiCalls.length, 4);
    assert.equal(postedIssueComments.length, 0);
  });

  test("respects an aborted signal at strategy entry", async () => {
    const ac = new AbortController();
    ac.abort();
    const { tk, aiCalls, postedIssueComments } = makeToolkit({
      resultsByPersona: ALL_SUCCEEDED,
    });

    await assert.rejects(
      issueInitialReviewStrategy.run(task, tk, ac.signal),
      /aborted|abort/i,
    );
    assert.equal(aiCalls.length, 0);
    assert.equal(postedIssueComments.length, 0);
  });
});
