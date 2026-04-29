import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentRunInput, AgentRunResult } from "../../src/domain/agent.js";
import type { GitHubSourceContext } from "../../src/domain/github.js";
import type { InstructionDefinition } from "../../src/domain/instruction.js";
import type { TaskRecord } from "../../src/domain/task.js";
import type { GitHubClient } from "../../src/domain/ports/github-client.js";
import type { WorkspaceManager } from "../../src/domain/ports/workspace-manager.js";
import { ExecutionService } from "../../src/services/execution-service.js";

const observeInstruction: InstructionDefinition = {
  id: "issue-comment-reply",
  revision: 1,
  sourceKind: "issue",
  mode: "observe",
  workflow: "observe",
  persona: "architecture",
  context: {
    includeIssueBody: true,
    includeIssueComments: true,
  },
  permissions: {
    codeRead: true,
    codeWrite: false,
    gitPush: false,
    prCreate: false,
    prUpdate: false,
    commentWrite: true,
  },
  githubActions: ["issue_comment"],
  execution: { timeoutSec: 1800 },
};

const mutateInstruction: InstructionDefinition = {
  id: "issue-implement",
  revision: 1,
  sourceKind: "issue",
  mode: "mutate",
  workflow: "mutate",
  persona: "implementation",
  context: { includeIssueBody: true, includeIssueComments: true },
  permissions: {
    codeRead: true,
    codeWrite: true,
    gitPush: true,
    prCreate: true,
    prUpdate: true,
    commentWrite: true,
  },
  githubActions: ["branch_push", "pr_create", "issue_comment"],
  execution: { timeoutSec: 3600 },
};

const prImplementInstruction: InstructionDefinition = {
  id: "pr-implement",
  revision: 1,
  sourceKind: "pull_request",
  mode: "mutate",
  workflow: "pr_implement",
  persona: "implementation",
  context: {
    includePrBody: true,
    includePrComments: true,
    includePrDiff: true,
  },
  permissions: {
    codeRead: true,
    codeWrite: true,
    gitPush: true,
    prCreate: false,
    prUpdate: false,
    commentWrite: true,
  },
  githubActions: ["branch_push", "pull_request_comment"],
  execution: { timeoutSec: 3600 },
};

const emptyLinkedRefs = { closes: [], bodyMentions: [] };

const issueContext: GitHubSourceContext = {
  kind: "issue",
  title: "Issue title",
  body: "Issue body",
  comments: [{ author: "alice", body: "Please fix this" }],
  linkedRefs: emptyLinkedRefs,
};

const pullRequestContext: GitHubSourceContext = {
  kind: "pull_request",
  title: "PR title",
  body: "PR body",
  comments: [{ author: "bob", body: "Needs tests" }],
  diff: "diff --git a/file.ts b/file.ts",
  baseRef: "main",
  headRef: "feature/pr-52",
  linkedRefs: emptyLinkedRefs,
};

function createTask(
  instructionId: string,
  source: TaskRecord["source"] = { kind: "issue", number: 100 },
): TaskRecord {
  return {
    taskId: "task_1",
    repo: { owner: "octo", name: "repo" },
    source,
    instructionId,
    instructionRevision: 1,
    agent: "claude",
    status: "running",
    priority: "normal",
    requestedBy: "test",
    createdAt: "2026-04-24T00:00:00.000Z",
    startedAt: "2026-04-24T00:01:00.000Z",
  };
}

interface BuildOptions {
  agentRun?: (input: AgentRunInput) => Promise<AgentRunResult>;
  hasChanges?: boolean;
  contextOverride?: GitHubSourceContext;
  installationToken?: string;
  defaultBranch?: string;
  workspaceCleanup?: () => void;
}

interface Fixture {
  service: ExecutionService;
  agentInputs: AgentRunInput[];
  contextArgs: unknown[][];
  cleanupCalled: { count: number };
  agentArtifactCleanupArgs: string[];
  observeWorkspaceArgs: unknown[][];
  mutateWorkspaceArgs: unknown[][];
  prImplementWorkspaceArgs: unknown[][];
  // Tracks any GitHubClient call that the runner should not make in
  // agent-driven mode (the runner now leaves all GitHub state changes
  // and PR creation to the agent).
  forbiddenCalls: { method: string; args: unknown[] }[];
}

function buildFixture(options: BuildOptions = {}): Fixture {
  const agentInputs: AgentRunInput[] = [];
  const contextArgs: unknown[][] = [];
  const cleanupCalled = { count: 0 };
  const observeWorkspaceArgs: unknown[][] = [];
  const mutateWorkspaceArgs: unknown[][] = [];
  const prImplementWorkspaceArgs: unknown[][] = [];
  const forbiddenCalls: { method: string; args: unknown[] }[] = [];
  const agentArtifactCleanupArgs: string[] = [];
  const installationToken = options.installationToken ?? "ghs_TEST_TOKEN";

  const githubClient: GitHubClient = {
    getSourceContext: async (...args) => {
      contextArgs.push(args);
      return options.contextOverride ?? issueContext;
    },
    getDefaultBranch: async () => options.defaultBranch ?? "main",
    getPullRequestState: async () => ({
      number: 0,
      isFork: false,
      state: "open" as const,
      merged: false,
      headRef: "feature/x",
    }),
    getIssueLabels: async () => ({ labels: [] }),
    getAppBotInfo: async () => ({ id: 1, login: "bot[bot]", slug: "bot" }),
    getInstallationAccessToken: async () => installationToken,
    postIssueComment: async (...args) => {
      forbiddenCalls.push({ method: "postIssueComment", args });
      return { commentId: 0, body: "" };
    },
    postPullRequestComment: async (...args) => {
      forbiddenCalls.push({ method: "postPullRequestComment", args });
      return { commentId: 0, body: "" };
    },
    updateIssueComment: async (...args) => {
      forbiddenCalls.push({ method: "updateIssueComment", args });
    },
    addReaction: async (...args) => {
      forbiddenCalls.push({ method: "addReaction", args });
      return { reactionId: 0 };
    },
    deleteReaction: async (...args) => {
      forbiddenCalls.push({ method: "deleteReaction", args });
    },
    deleteIssueComment: async (...args) => {
      forbiddenCalls.push({ method: "deleteIssueComment", args });
    },
    findCommentByMarker: async () => null,
    findOpenPullRequestByBranch: async () => null,
    createPullRequest: async (input) => {
      forbiddenCalls.push({ method: "createPullRequest", args: [input] });
      return {
        number: 1,
        url: "https://example.test/pr/1",
        branchName: input.branchName,
      };
    },
    updatePullRequest: async (number, input) => {
      forbiddenCalls.push({ method: "updatePullRequest", args: [number, input] });
      return {
        number,
        url: `https://example.test/pr/${number}`,
        branchName: input.branchName,
      };
    },
  };

  const workspaceManager: WorkspaceManager = {
    prepareObserveWorkspace: async (...args) => {
      observeWorkspaceArgs.push(args);
      return { workspacePath: "/tmp/observe" };
    },
    prepareMutateWorkspace: async (...args) => {
      mutateWorkspaceArgs.push(args);
      return {
        workspacePath: "/tmp/mutate",
        branchName: "ai/issue-100",
      };
    },
    preparePrImplementWorkspace: async (...args) => {
      prImplementWorkspaceArgs.push(args);
      return {
        workspacePath: "/tmp/pr-implement",
        branchName: "feature/pr-52",
      };
    },
    hasChanges: async () => options.hasChanges ?? false,
    commitAll: async () => {
      forbiddenCalls.push({ method: "commitAll", args: [] });
    },
    pushBranch: async (...args) => {
      forbiddenCalls.push({ method: "pushBranch", args });
    },
    cleanupWorkspace: async () => {
      cleanupCalled.count += 1;
      options.workspaceCleanup?.();
    },
  };

  const service = new ExecutionService({
    githubClient,
    workspaceManager,
    agentRegistry: {
      resolve: () => ({
        run: async (input) => {
          agentInputs.push(input);
          return options.agentRun
            ? options.agentRun(input)
            : { kind: "succeeded", stdout: "ok" };
        },
      }),
    },
    logStore: {
      write: async () => {},
      cleanupExpired: async () => {},
    },
    promptAssets: {
      commonRules: "",
      personas: { architecture: "", implementation: "" },
      modePolicies: {
        observe: "- Mode: observe",
        mutate: "- Mode: mutate",
      },
    },
    cleanupAgentArtifacts: async (workspacePath) => {
      agentArtifactCleanupArgs.push(workspacePath);
    },
  });

  return {
    service,
    agentInputs,
    contextArgs,
    cleanupCalled,
    agentArtifactCleanupArgs,
    observeWorkspaceArgs,
    mutateWorkspaceArgs,
    prImplementWorkspaceArgs,
    forbiddenCalls,
  };
}

describe("ExecutionService (agent-driven)", () => {
  test("observe: spawns agent, cleans up, makes no GitHub state mutation of its own", async () => {
    const fixture = buildFixture();

    const result = await fixture.service.execute({
      task: createTask("issue-comment-reply"),
      instruction: observeInstruction,
    });

    assert.deepEqual(result, { status: "succeeded" });
    assert.equal(fixture.agentInputs.length, 1);
    assert.equal(fixture.cleanupCalled.count, 1);
    assert.deepEqual(fixture.agentArtifactCleanupArgs, ["/tmp/observe"]);
    assert.deepEqual(fixture.forbiddenCalls, []);
  });

  test("mutate/observe/pr_implement: agent artifacts cleanup runs after workspace cleanup in finally", async () => {
    const fixtureMutate = buildFixture({ hasChanges: true });
    await fixtureMutate.service.execute({
      task: createTask("issue-implement"),
      instruction: mutateInstruction,
    });
    assert.deepEqual(fixtureMutate.agentArtifactCleanupArgs, ["/tmp/mutate"]);

    const fixturePr = buildFixture({ contextOverride: pullRequestContext });
    await fixturePr.service.execute({
      task: createTask("pr-implement", { kind: "pull_request", number: 52 }),
      instruction: prImplementInstruction,
    });
    assert.deepEqual(fixturePr.agentArtifactCleanupArgs, ["/tmp/pr-implement"]);
  });

  test("agent artifacts cleanup runs even when the agent fails", async () => {
    const fixture = buildFixture({
      agentRun: async () => ({
        kind: "failed",
        exitCode: 2,
        stdout: "",
        stderr: "boom",
      }),
    });

    await fixture.service.execute({
      task: createTask("issue-comment-reply"),
      instruction: observeInstruction,
    });

    assert.deepEqual(fixture.agentArtifactCleanupArgs, ["/tmp/observe"]);
  });

  test("observe: passes the requested instruction context into getSourceContext and the prompt", async () => {
    const fixture = buildFixture();

    await fixture.service.execute({
      task: createTask("issue-comment-reply"),
      instruction: { ...observeInstruction, context: { includeIssueBody: true } },
    });

    assert.deepEqual(fixture.contextArgs[0]?.[2], { includeIssueBody: true });
    assert.match(fixture.agentInputs[0]?.prompt ?? "", /Body:/);
    assert.doesNotMatch(fixture.agentInputs[0]?.prompt ?? "", /Comments:/);
  });

  test("observe: forwards the installation token to the agent runner", async () => {
    const fixture = buildFixture({ installationToken: "ghs_OBSERVE_TOKEN" });

    await fixture.service.execute({
      task: createTask("issue-comment-reply"),
      instruction: observeInstruction,
    });

    assert.equal(fixture.agentInputs[0]?.installationToken, "ghs_OBSERVE_TOKEN");
  });

  test("observe: checks out the PR head ref when source is a pull request", async () => {
    const fixture = buildFixture({ contextOverride: pullRequestContext });

    await fixture.service.execute({
      task: createTask("pr-review-comment", { kind: "pull_request", number: 52 }),
      instruction: { ...observeInstruction, sourceKind: "pull_request" },
    });

    assert.equal(fixture.observeWorkspaceArgs[0]?.[1], pullRequestContext.headRef);
  });

  test("observe: forwards rate_limited result and skips workspace cleanup work but still cleans up", async () => {
    const fixture = buildFixture({
      agentRun: async () => ({
        kind: "rate_limited",
        agentName: "claude",
        signal: "exit_code=137",
      }),
    });

    const result = await fixture.service.execute({
      task: createTask("issue-comment-reply"),
      instruction: observeInstruction,
    });

    assert.deepEqual(result, { status: "rate_limited", agentName: "claude" });
    assert.equal(fixture.cleanupCalled.count, 1);
    assert.deepEqual(fixture.forbiddenCalls, []);
  });

  test("observe: forwards failed result with the agent stderr as errorSummary", async () => {
    const fixture = buildFixture({
      agentRun: async () => ({
        kind: "failed",
        exitCode: 2,
        stdout: "",
        stderr: "boom",
      }),
    });

    const result = await fixture.service.execute({
      task: createTask("issue-comment-reply"),
      instruction: observeInstruction,
    });

    assert.deepEqual(result, { status: "failed", errorSummary: "boom" });
    assert.deepEqual(fixture.forbiddenCalls, []);
  });

  test("mutate: spawns agent on a branch named ai/<kind>-<number>, makes no runner-side push/PR call", async () => {
    const fixture = buildFixture({ hasChanges: true });

    const result = await fixture.service.execute({
      task: createTask("issue-implement"),
      instruction: mutateInstruction,
    });

    assert.deepEqual(result, { status: "succeeded" });
    assert.equal(fixture.mutateWorkspaceArgs[0]?.[3], "ai/issue-100");
    assert.equal(fixture.cleanupCalled.count, 1);
    assert.deepEqual(fixture.forbiddenCalls, []);
  });

  test("mutate: even when the agent leaves no file changes, the runner does not post a no-op comment (agent owns the comment)", async () => {
    const fixture = buildFixture({ hasChanges: false });

    const result = await fixture.service.execute({
      task: createTask("issue-implement"),
      instruction: mutateInstruction,
    });

    assert.deepEqual(result, { status: "succeeded" });
    assert.deepEqual(fixture.forbiddenCalls, []);
  });

  test("pr_implement: requires a pull_request source", async () => {
    const fixture = buildFixture();

    const result = await fixture.service.execute({
      task: createTask("pr-implement"),
      instruction: prImplementInstruction,
    });

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.match(result.errorSummary, /pull_request source/);
    assert.equal(fixture.cleanupCalled.count, 0);
  });

  test("pr_implement: prepares the PR head workspace and forwards the installation token", async () => {
    const fixture = buildFixture({
      contextOverride: pullRequestContext,
      installationToken: "ghs_PR_IMPLEMENT_TOKEN",
    });

    const result = await fixture.service.execute({
      task: createTask("pr-implement", { kind: "pull_request", number: 52 }),
      instruction: prImplementInstruction,
    });

    assert.deepEqual(result, { status: "succeeded" });
    assert.equal(fixture.prImplementWorkspaceArgs[0]?.[2], pullRequestContext.headRef);
    assert.equal(fixture.agentInputs[0]?.installationToken, "ghs_PR_IMPLEMENT_TOKEN");
    assert.deepEqual(fixture.forbiddenCalls, []);
  });

  test("pr_implement: forwards rate_limited from the agent", async () => {
    const fixture = buildFixture({
      contextOverride: pullRequestContext,
      agentRun: async () => ({
        kind: "rate_limited",
        agentName: "claude",
        signal: "pattern=429",
      }),
    });

    const result = await fixture.service.execute({
      task: createTask("pr-implement", { kind: "pull_request", number: 52 }),
      instruction: prImplementInstruction,
    });

    assert.deepEqual(result, { status: "rate_limited", agentName: "claude" });
  });
});
