import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { FileQueueStore } from "../../src/infra/queue/file-queue-store.js";

describe("FileQueueStore", () => {
  test("enqueues a task as queued", async () => {
    const root = await mkdtemp(join(tmpdir(), "queue-store-"));

    try {
      const store = new FileQueueStore({ dataDir: root });
      const task = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 100 },
        instructionId: "issue-implement",
        agent: "claude",
        requestedBy: "test",
      });

      assert.equal(task.status, "queued");
      assert.equal(task.source.number, 100);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("supersedes older queued tasks for the same source", async () => {
    const root = await mkdtemp(join(tmpdir(), "queue-store-"));

    try {
      const store = new FileQueueStore({ dataDir: root });

      const first = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 100 },
        instructionId: "issue-comment-reply",
        agent: "claude",
        requestedBy: "test",
      });

      const second = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 100 },
        instructionId: "issue-implement",
        agent: "claude",
        requestedBy: "test",
      });

      const tasks = await store.listTasks();
      const reloadedFirst = tasks.find((task) => task.taskId === first.taskId);
      const reloadedSecond = tasks.find((task) => task.taskId === second.taskId);

      assert.equal(reloadedFirst?.status, "superseded");
      assert.equal(reloadedSecond?.status, "queued");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("marks tasks as running and then completed", async () => {
    const root = await mkdtemp(join(tmpdir(), "queue-store-"));

    try {
      const store = new FileQueueStore({ dataDir: root });
      const task = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 100 },
        instructionId: "issue-implement",
        agent: "claude",
        requestedBy: "test",
      });

      await store.startTask(task.taskId, 1);
      await store.completeTask(task.taskId, { status: "succeeded" });

      const reloadedTask = await store.getTask(task.taskId);

      assert.equal(reloadedTask?.status, "succeeded");
      assert.equal(reloadedTask?.instructionRevision, 1);
      assert.equal(typeof reloadedTask?.startedAt, "string");
      assert.equal(typeof reloadedTask?.finishedAt, "string");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("injects default agent='claude' for legacy records that lack the field", async () => {
    const root = await mkdtemp(join(tmpdir(), "queue-store-"));

    try {
      const tasksFilePath = join(root, "tasks.json");
      const legacyRecord = {
        taskId: "task_legacy",
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 100 },
        instructionId: "issue-comment-reply",
        status: "queued",
        priority: "normal",
        requestedBy: "test",
        createdAt: "2026-04-24T00:00:00.000Z",
      };
      await (await import("node:fs/promises")).writeFile(
        tasksFilePath,
        JSON.stringify([legacyRecord], null, 2),
        "utf8",
      );

      const store = new FileQueueStore({ dataDir: root });
      const tasks = await store.listTasks();

      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]?.agent, "claude");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recovers stale running tasks as failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "queue-store-"));

    try {
      const store = new FileQueueStore({ dataDir: root });
      const task = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 100 },
        instructionId: "issue-implement",
        agent: "claude",
        requestedBy: "test",
      });

      await store.startTask(task.taskId, 1);
      await store.recoverRunningTasks("daemon interrupted before completion");

      const reloadedTask = await store.getTask(task.taskId);

      assert.equal(reloadedTask?.status, "failed");
      assert.equal(
        reloadedTask?.errorSummary,
        "daemon interrupted before completion",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
