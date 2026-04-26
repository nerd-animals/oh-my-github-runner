import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EnqueueService } from "../../src/services/enqueue-service.js";
import type { InstructionDefinition } from "../../src/domain/instruction.js";

const issueImplementInstruction: InstructionDefinition = {
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

describe("EnqueueService", () => {
  test("rejects a source kind mismatch", async () => {
    const service = new EnqueueService({
      instructionLoader: {
        loadById: async () => issueImplementInstruction,
      },
      repoAllowlist: {
        isAllowed: () => true,
      },
      queueStore: {
        enqueue: async () => {
          throw new Error("should not be called");
        },
        listTasks: async () => [],
        getTask: async () => undefined,
        startTask: async () => {
          throw new Error("should not be called");
        },
        completeTask: async () => {
          throw new Error("should not be called");
        },
        revertToQueued: async () => {
          throw new Error("should not be called");
        },
        recoverRunningTasks: async () => {},
      },
    });

    await assert.rejects(
      service.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "pull_request", number: 52 },
        instructionId: "issue-implement",
        agent: "claude",
        requestedBy: "test",
      }),
      /source kind/i,
    );
  });

  test("rejects an enqueue for a repo outside the allowlist", async () => {
    const service = new EnqueueService({
      instructionLoader: {
        loadById: async () => issueImplementInstruction,
      },
      queueStore: {
        enqueue: async () => {
          throw new Error("should not be called");
        },
        listTasks: async () => [],
        getTask: async () => undefined,
        startTask: async () => {
          throw new Error("should not be called");
        },
        completeTask: async () => {
          throw new Error("should not be called");
        },
        revertToQueued: async () => {
          throw new Error("should not be called");
        },
        recoverRunningTasks: async () => {},
      },
      repoAllowlist: {
        isAllowed: () => false,
      },
    });

    await assert.rejects(
      service.enqueue({
        repo: { owner: "rogue", name: "repo" },
        source: { kind: "issue", number: 1 },
        instructionId: "issue-implement",
        agent: "claude",
        requestedBy: "test",
      }),
      /not in the allowlist/,
    );
  });

  test("enqueues when the instruction matches the source kind", async () => {
    const service = new EnqueueService({
      instructionLoader: {
        loadById: async () => issueImplementInstruction,
      },
      repoAllowlist: {
        isAllowed: () => true,
      },
      queueStore: {
        enqueue: async (input) => ({
          taskId: "task_1",
          repo: input.repo,
          source: input.source,
          instructionId: input.instructionId,
          agent: input.agent,
          status: "queued",
          priority: input.priority ?? "normal",
          requestedBy: input.requestedBy,
          createdAt: "2026-04-24T00:00:00.000Z",
        }),
        listTasks: async () => [],
        getTask: async () => undefined,
        startTask: async () => {
          throw new Error("should not be called");
        },
        completeTask: async () => {
          throw new Error("should not be called");
        },
        revertToQueued: async () => {
          throw new Error("should not be called");
        },
        recoverRunningTasks: async () => {},
      },
    });

    const task = await service.enqueue({
      repo: { owner: "octo", name: "repo" },
      source: { kind: "issue", number: 100 },
      instructionId: "issue-implement",
      agent: "claude",
      requestedBy: "test",
    });

    assert.equal(task.taskId, "task_1");
    assert.equal(task.status, "queued");
    assert.equal(task.agent, "claude");
  });
});
