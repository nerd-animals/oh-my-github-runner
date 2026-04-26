import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentRunInput, AgentRunResult } from "../../src/domain/agent.js";
import type { CreatePullRequestInput, GitHubSourceContext } from "../../src/domain/github.js";
import type { InstructionDefinition } from "../../src/domain/instruction.js";
import type { TaskRecord } from "../../src/domain/task.js";
import { ExecutionService } from "../../src/services/execution-service.js";

const observeInstruction: InstructionDefinition = {
  id: "issue-comment-reply",
  revision: 1,
  sourceKind: "issue",
  mode: "observe",
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
  execution: {
    timeoutSec: 1800,
  },
};

const mutateInstruction: InstructionDefinition = {
  id: "issue-implement",
  revision: 1,
  sourceKind: "issue",
  mode: "mutate",
  context: {
    includeIssueBody: true,
    includeIssueComments: true,
    includeLinkedPrs: true,
  },
  permissions: {
    codeRead: true,
    codeWrite: true,
    gitPush: true,
    prCreate: true,
    prUpdate: true,
    commentWrite: true,
  },
  githubActions: ["branch_push", "pr_create", "issue_comment"],
  execution: {
    timeoutSec: 3600,
  },
};

const pullRequestObserveInstruction: InstructionDefinition = {
  id: "pr-review-comment",
  revision: 1,
  sourceKind: "pull_request",
  mode: "observe",
  context: {
    includePrBody: true,
    includePrComments: true,
    includePrDiff: true,
  },
  permissions: {
    codeRead: true,
    codeWrite: false,
    gitPush: false,
    prCreate: false,
    prUpdate: false,
    commentWrite: true,
  },
  githubActions: ["pull_request_comment"],
  execution: {
    timeoutSec: 1800,
  },
};

const issueContext: GitHubSourceContext = {
  kind: "issue",
  title: "Issue title",
  body: "Issue body",
  comments: [{ author: "alice", body: "Please fix this" }],
};

const pullRequestContext: GitHubSourceContext = {
  kind: "pull_request",
  title: "PR title",
  body: "PR body",
  comments: [{ author: "bob", body: "Needs tests" }],
  diff: "diff --git a/file.ts b/file.ts",
  baseRef: "main",
  headRef: "feature/pr-52",
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

describe("ExecutionService", () => {
  test("passes instruction context to github loading and omits disabled prompt sections", async () => {
    const prompts: AgentRunInput[] = [];
    const contextArgs: unknown[][] = [];

    const instruction: InstructionDefinition = {
      ...observeInstruction,
      context: {},
    };

    const service = new ExecutionService({
      githubClient: {
        getSourceContext: async (...args) => {
          contextArgs.push(args);
          return issueContext;
        },
        getDefaultBranch: async () => "main",
        getPullRequestState: async () => ({
          number: 0,
          isFork: false,
          state: "open" as const,
          merged: false,
          headRef: "feature/x",
        }),
        getIssueLabels: async () => ({ labels: [] }),
        getAppBotInfo: async () => ({
          id: 1,
          login: "bot[bot]",
          slug: "bot",
        }),
        postIssueComment: async () => {},
        postPullRequestComment: async () => {},
        findOpenPullRequestByBranch: async () => null,
        createPullRequest: async () => ({
          number: 1,
          url: "https://example.test/pr/1",
          branchName: "ai/issue-100",
        }),
        updatePullRequest: async () => ({
          number: 1,
          url: "https://example.test/pr/1",
          branchName: "ai/issue-100",
        }),
      },
      workspaceManager: {
        prepareObserveWorkspace: async () => ({
          workspacePath: "/tmp/observe",
        }),
        prepareMutateWorkspace: async () => ({
          workspacePath: "/tmp/mutate",
          branchName: "ai/issue-100",
        }),
        hasChanges: async () => false,
        commitAll: async () => {},
        pushBranch: async () => {},
        cleanupWorkspace: async () => {},
      },
      agentRegistry: {
        resolve: () => ({
          run: async (input: AgentRunInput): Promise<AgentRunResult> => {
            prompts.push(input);
            return {
              exitCode: 0,
              stdout: "Observed summary",
              stderr: "",
            };
          },
        }),
      },
      logStore: {
        write: async () => {},
        cleanupExpired: async () => {},
      },
    });

    const result = await service.execute({
      task: createTask("issue-comment-reply"),
      instruction,
    });

    assert.equal(result.status, "succeeded");
    assert.deepEqual(contextArgs[0]?.[2], instruction.context);
    assert.equal(prompts.length, 1);
    assert.doesNotMatch(prompts[0]?.prompt ?? "", /Body:/);
    assert.doesNotMatch(prompts[0]?.prompt ?? "", /Comments:/);
  });

  test("runs observe work and posts an issue comment", async () => {
    const postedComments: string[] = [];
    const prompts: AgentRunInput[] = [];

    const service = new ExecutionService({
      githubClient: {
        getSourceContext: async () => issueContext,
        getDefaultBranch: async () => "main",
        getPullRequestState: async () => ({
          number: 0,
          isFork: false,
          state: "open" as const,
          merged: false,
          headRef: "feature/x",
        }),
        getIssueLabels: async () => ({ labels: [] }),
        getAppBotInfo: async () => ({
          id: 1,
          login: "bot[bot]",
          slug: "bot",
        }),
        postIssueComment: async (_repo, _issueNumber, body) => {
          postedComments.push(body);
        },
        postPullRequestComment: async () => {},
        findOpenPullRequestByBranch: async () => null,
        createPullRequest: async () => ({
          number: 1,
          url: "https://example.test/pr/1",
          branchName: "ai/issue-100",
        }),
        updatePullRequest: async () => ({
          number: 1,
          url: "https://example.test/pr/1",
          branchName: "ai/issue-100",
        }),
      },
      workspaceManager: {
        prepareObserveWorkspace: async () => ({
          workspacePath: "/tmp/observe",
        }),
        prepareMutateWorkspace: async () => ({
          workspacePath: "/tmp/mutate",
          branchName: "ai/issue-100",
        }),
        hasChanges: async () => false,
        commitAll: async () => {},
        pushBranch: async () => {},
        cleanupWorkspace: async () => {},
      },
      agentRegistry: {
        resolve: () => ({
          run: async (input: AgentRunInput): Promise<AgentRunResult> => {
            prompts.push(input);
            return {
              exitCode: 0,
              stdout: "Observed summary",
              stderr: "",
            };
          },
        }),
      },
      logStore: {
        write: async () => {},
        cleanupExpired: async () => {},
      },
    });

    const result = await service.execute({
      task: createTask("issue-comment-reply"),
      instruction: observeInstruction,
    });

    assert.equal(result.status, "succeeded");
    assert.equal(prompts.length, 1);
    assert.match(postedComments[0] ?? "", /Observed summary/);
    assert.match(postedComments[0] ?? "", /issue-comment-reply r1/);
  });

  test("checks out the pull request head ref for observe work", async () => {
    const observeWorkspaceArgs: unknown[][] = [];

    const service = new ExecutionService({
      githubClient: {
        getSourceContext: async () => pullRequestContext,
        getDefaultBranch: async () => "main",
        getPullRequestState: async () => ({
          number: 0,
          isFork: false,
          state: "open" as const,
          merged: false,
          headRef: "feature/x",
        }),
        getIssueLabels: async () => ({ labels: [] }),
        getAppBotInfo: async () => ({
          id: 1,
          login: "bot[bot]",
          slug: "bot",
        }),
        postIssueComment: async () => {},
        postPullRequestComment: async () => {},
        findOpenPullRequestByBranch: async () => null,
        createPullRequest: async () => ({
          number: 1,
          url: "https://example.test/pr/1",
          branchName: "ai/pr-52",
        }),
        updatePullRequest: async () => ({
          number: 1,
          url: "https://example.test/pr/1",
          branchName: "ai/pr-52",
        }),
      },
      workspaceManager: {
        prepareObserveWorkspace: async (...args) => {
          observeWorkspaceArgs.push(args);
          return {
            workspacePath: "/tmp/observe-pr",
          };
        },
        prepareMutateWorkspace: async () => ({
          workspacePath: "/tmp/mutate",
          branchName: "ai/pr-52",
        }),
        hasChanges: async () => false,
        commitAll: async () => {},
        pushBranch: async () => {},
        cleanupWorkspace: async () => {},
      },
      agentRegistry: {
        resolve: () => ({
          run: async () => ({
            exitCode: 0,
            stdout: "Review summary",
            stderr: "",
          }),
        }),
      },
      logStore: {
        write: async () => {},
        cleanupExpired: async () => {},
      },
    });

    const result = await service.execute({
      task: createTask("pr-review-comment", { kind: "pull_request", number: 52 }),
      instruction: pullRequestObserveInstruction,
    });

    assert.equal(result.status, "succeeded");
    assert.equal(observeWorkspaceArgs[0]?.[1], pullRequestContext.headRef);
  });

  test("runs mutate work, pushes changes, and creates a pull request", async () => {
    const createdPullRequests: CreatePullRequestInput[] = [];
    const postedComments: string[] = [];
    const workspaceCalls: string[] = [];

    const service = new ExecutionService({
      githubClient: {
        getSourceContext: async () => issueContext,
        getDefaultBranch: async () => "main",
        getPullRequestState: async () => ({
          number: 0,
          isFork: false,
          state: "open" as const,
          merged: false,
          headRef: "feature/x",
        }),
        getIssueLabels: async () => ({ labels: [] }),
        getAppBotInfo: async () => ({
          id: 1,
          login: "bot[bot]",
          slug: "bot",
        }),
        postIssueComment: async (_repo, _issueNumber, body) => {
          postedComments.push(body);
        },
        postPullRequestComment: async () => {},
        findOpenPullRequestByBranch: async () => null,
        createPullRequest: async (input) => {
          createdPullRequests.push(input);
          return {
            number: 15,
            url: "https://example.test/pr/15",
            branchName: input.branchName,
          };
        },
        updatePullRequest: async () => {
          throw new Error("should not update in this test");
        },
      },
      workspaceManager: {
        prepareObserveWorkspace: async () => ({
          workspacePath: "/tmp/observe",
        }),
        prepareMutateWorkspace: async () => {
          workspaceCalls.push("prepare");
          return {
            workspacePath: "/tmp/mutate",
            branchName: "ai/issue-100",
          };
        },
        hasChanges: async () => true,
        commitAll: async () => {
          workspaceCalls.push("commit");
        },
        pushBranch: async () => {
          workspaceCalls.push("push");
        },
        cleanupWorkspace: async () => {
          workspaceCalls.push("cleanup");
        },
      },
      agentRegistry: {
        resolve: () => ({
          run: async () => ({
            exitCode: 0,
            stdout: "Implemented fix",
            stderr: "",
          }),
        }),
      },
      logStore: {
        write: async () => {},
        cleanupExpired: async () => {},
      },
    });

    const result = await service.execute({
      task: createTask("issue-implement"),
      instruction: mutateInstruction,
    });

    assert.equal(result.status, "succeeded");
    assert.deepEqual(workspaceCalls, ["prepare", "commit", "push", "cleanup"]);
    assert.equal(createdPullRequests.length, 1);
    assert.match(createdPullRequests[0]?.title ?? "", /issue #100/i);
    assert.match(postedComments[0] ?? "", /https:\/\/example\.test\/pr\/15/);
  });

  test("marks mutate work as succeeded without PR when no diff exists", async () => {
    const service = new ExecutionService({
      githubClient: {
        getSourceContext: async () => issueContext,
        getDefaultBranch: async () => "main",
        getPullRequestState: async () => ({
          number: 0,
          isFork: false,
          state: "open" as const,
          merged: false,
          headRef: "feature/x",
        }),
        getIssueLabels: async () => ({ labels: [] }),
        getAppBotInfo: async () => ({
          id: 1,
          login: "bot[bot]",
          slug: "bot",
        }),
        postIssueComment: async () => {},
        postPullRequestComment: async () => {},
        findOpenPullRequestByBranch: async () => null,
        createPullRequest: async () => {
          throw new Error("should not create a PR");
        },
        updatePullRequest: async () => {
          throw new Error("should not update a PR");
        },
      },
      workspaceManager: {
        prepareObserveWorkspace: async () => ({
          workspacePath: "/tmp/observe",
        }),
        prepareMutateWorkspace: async () => ({
          workspacePath: "/tmp/mutate",
          branchName: "ai/issue-100",
        }),
        hasChanges: async () => false,
        commitAll: async () => {
          throw new Error("should not commit");
        },
        pushBranch: async () => {
          throw new Error("should not push");
        },
        cleanupWorkspace: async () => {},
      },
      agentRegistry: {
        resolve: () => ({
          run: async () => ({
            exitCode: 0,
            stdout: "No changes needed",
            stderr: "",
          }),
        }),
      },
      logStore: {
        write: async () => {},
        cleanupExpired: async () => {},
      },
    });

    const result = await service.execute({
      task: createTask("issue-implement"),
      instruction: mutateInstruction,
    });

    assert.equal(result.status, "succeeded");
  });
});
