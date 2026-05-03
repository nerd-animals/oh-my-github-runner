import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { GitHubSourceContext } from "../../src/domain/github.js";
import type { GitHubClient } from "../../src/domain/ports/github-client.js";
import type { LogStore } from "../../src/domain/ports/log-store.js";
import type { ToolRunner } from "../../src/domain/ports/tool-runner.js";
import type { WorkspaceManager } from "../../src/domain/ports/workspace-manager.js";
import type { TaskRecord } from "../../src/domain/task.js";
import type { ToolRunInput, ToolRunResult } from "../../src/domain/tool.js";
import type { PromptRenderer } from "../../src/infra/prompts/prompt-renderer.js";
import { ToolkitFactory } from "../../src/services/toolkit.js";
import type { ToolRegistry } from "../../src/services/tool-registry.js";

const task: TaskRecord = {
  taskId: "task_tk_1",
  repo: { owner: "octo", name: "repo" },
  source: { kind: "issue", number: 11 },
  instructionId: "issue-comment-reply",
  status: "running",
  priority: "normal",
  requestedBy: "test",
  createdAt: "2026-04-30T00:00:00.000Z",
};

const issueContext: GitHubSourceContext = {
  kind: "issue",
  title: "T",
  body: "",
  comments: [],
  linkedRefs: { closes: [], bodyMentions: [] },
};

interface RunnerCall {
  toolName: string;
  input: ToolRunInput;
}

function buildToolkit(opts: {
  declared: readonly string[];
  runners?: Record<string, ToolRunner>;
}) {
  const calls: RunnerCall[] = [];
  const cleanups: string[] = [];
  const stubRunner = (name: string): ToolRunner => ({
    run: async (input): Promise<ToolRunResult> => {
      calls.push({ toolName: name, input });
      return { kind: "succeeded", stdout: `ok-from-${name}` };
    },
    cleanupArtifacts: async (workspacePath) => {
      cleanups.push(`${name}:${workspacePath}`);
    },
  });
  const runners = opts.runners ?? {
    claude: stubRunner("claude"),
    codex: stubRunner("codex"),
  };
  const toolRegistry: Pick<ToolRegistry, "resolve"> = {
    resolve: (name) => {
      const runner = runners[name];
      if (runner === undefined) throw new Error(`Unknown tool: ${name}`);
      return runner;
    },
  };
  const githubClient = {
    getSourceContext: async () => issueContext,
    getInstallationAccessToken: async () => "ghs_FAKE",
    getDefaultBranch: async () => "main",
    postIssueComment: async () => {
      throw new Error("not used");
    },
    postPullRequestComment: async () => {
      throw new Error("not used");
    },
    createIssue: async () => ({
      number: 501,
      url: "https://github.com/octo/repo/issues/501",
    }),
    closeIssue: async () => {},
  } as unknown as GitHubClient;
  const workspaceManager = {
    prepareObserveWorkspace: async () => ({
      workspacePath: "/tmp/ws",
    }),
    cleanupWorkspace: async () => {},
  } as unknown as WorkspaceManager;
  const renderCalls: Array<{ workspacePath: string }> = [];
  const promptRenderer = {
    render: async (
      _fragments: unknown,
      _ctx: unknown,
      workspacePath: string,
    ) => {
      renderCalls.push({ workspacePath });
      return "rendered prompt";
    },
  } as unknown as PromptRenderer;
  const logStore = {
    write: async () => {},
  } as unknown as LogStore;

  const factory = new ToolkitFactory({
    githubClient,
    workspaceManager,
    toolRegistry,
    logStore,
    promptRenderer,
    toolsForTask: () => opts.declared,
  });
  return { factory, calls, cleanups, renderCalls };
}

describe("ToolkitFactory.create", () => {
  test("throws when strategy declares no tools", () => {
    const { factory } = buildToolkit({ declared: [] });
    assert.throws(
      () => factory.create(task),
      /declares no tools/i,
    );
  });
});

describe("toolkit.ai.run — single-tool strategy", () => {
  test("resolves automatically to the only declared tool when opts.tool is omitted", async () => {
    const { factory, calls } = buildToolkit({ declared: ["claude"] });
    const tk = factory.create(task);

    await using ws = await tk.workspace.prepareObserve(task);
    void ws;
    await tk.github.fetchContext(task);

    const result = await tk.ai.run({
      prompt: [{ kind: "literal", text: "hi" }],
    });

    assert.equal(result.kind, "succeeded");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.toolName, "claude");
  });

  test("rejects an explicit opts.tool that isn't declared", async () => {
    const { factory } = buildToolkit({ declared: ["claude"] });
    const tk = factory.create(task);

    await using ws = await tk.workspace.prepareObserve(task);
    void ws;
    await tk.github.fetchContext(task);

    const result = await tk.ai.run({
      tool: "codex",
      prompt: [{ kind: "literal", text: "hi" }],
    });

    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.match(result.errorSummary, /not in strategy's declared uses/);
  });
});

describe("toolkit.ai.run — multi-tool strategy", () => {
  test("requires opts.tool to disambiguate", async () => {
    const { factory } = buildToolkit({ declared: ["claude", "codex"] });
    const tk = factory.create(task);

    await using ws = await tk.workspace.prepareObserve(task);
    void ws;
    await tk.github.fetchContext(task);

    const result = await tk.ai.run({
      prompt: [{ kind: "literal", text: "hi" }],
    });

    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.match(result.errorSummary, /requires opts\.tool/);
  });

  test("routes to the requested tool when opts.tool is in declared set", async () => {
    const { factory, calls } = buildToolkit({
      declared: ["claude", "codex"],
    });
    const tk = factory.create(task);

    await using ws = await tk.workspace.prepareObserve(task);
    void ws;
    await tk.github.fetchContext(task);

    await tk.ai.run({
      tool: "codex",
      prompt: [{ kind: "literal", text: "first" }],
    });
    await tk.ai.run({
      tool: "claude",
      prompt: [{ kind: "literal", text: "second" }],
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.toolName, "codex");
    assert.equal(calls[1]?.toolName, "claude");
  });

  test("rejects an opts.tool outside the declared set", async () => {
    const { factory } = buildToolkit({ declared: ["claude", "codex"] });
    const tk = factory.create(task);

    await using ws = await tk.workspace.prepareObserve(task);
    void ws;
    await tk.github.fetchContext(task);

    const result = await tk.ai.run({
      tool: "haiku",
      prompt: [{ kind: "literal", text: "hi" }],
    });

    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.match(result.errorSummary, /not in strategy's declared uses/);
  });
});

describe("toolkit.ai.run — prompt render wiring", () => {
  test("forwards active workspace path to PromptRenderer.render", async () => {
    const { factory, renderCalls } = buildToolkit({ declared: ["claude"] });
    const tk = factory.create(task);

    await using ws = await tk.workspace.prepareObserve(task);
    void ws;
    await tk.github.fetchContext(task);

    await tk.ai.run({
      prompt: [{ kind: "literal", text: "hi" }],
    });

    assert.equal(renderCalls.length, 1);
    assert.equal(renderCalls[0]?.workspacePath, "/tmp/ws");
  });

  test("forwards outputSchema to the selected runner", async () => {
    const { factory, calls } = buildToolkit({ declared: ["codex"] });
    const tk = factory.create(task);

    await using ws = await tk.workspace.prepareObserve(task);
    void ws;
    await tk.github.fetchContext(task);

    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["replyComment"],
      properties: {
        replyComment: { type: "string" },
      },
    };

    await tk.ai.run({
      prompt: [{ kind: "literal", text: "hi" }],
      outputSchema: schema,
    });

    assert.deepEqual(calls[0]?.input.outputSchema, schema);
  });
});

describe("toolkit cleanup fan-out", () => {
  test("calls cleanupArtifacts on every declared tool when the workspace disposes", async () => {
    const { factory, cleanups } = buildToolkit({
      declared: ["claude", "codex"],
    });
    const tk = factory.create(task);

    {
      await using ws = await tk.workspace.prepareObserve(task);
      void ws;
    }

    assert.deepEqual(cleanups.sort(), [
      "claude:/tmp/ws",
      "codex:/tmp/ws",
    ]);
  });
});
