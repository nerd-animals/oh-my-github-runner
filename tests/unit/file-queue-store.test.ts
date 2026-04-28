import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
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

      assert.deepEqual(await readdir(join(root, "queued")), [
        `${task.taskId}.json`,
      ]);
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
      const reloadedSecond = tasks.find(
        (task) => task.taskId === second.taskId,
      );

      assert.equal(reloadedFirst?.status, "superseded");
      assert.equal(reloadedSecond?.status, "queued");

      // Status is encoded by directory placement, not just by the field.
      assert.deepEqual(await readdir(join(root, "queued")), [
        `${second.taskId}.json`,
      ]);
      assert.deepEqual(await readdir(join(root, "superseded")), [
        `${first.taskId}.json`,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("listInStatus returns queued tasks in createdAt order regardless of filename order", async () => {
    const root = await mkdtemp(join(tmpdir(), "queue-store-"));

    try {
      const store = new FileQueueStore({ dataDir: root });

      // Three different sources so supersede doesn't fire. Enqueued in
      // order A, B, C.
      const a = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 1 },
        instructionId: "issue-implement",
        agent: "claude",
        requestedBy: "test",
      });
      const b = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 2 },
        instructionId: "issue-implement",
        agent: "claude",
        requestedBy: "test",
      });
      const c = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 3 },
        instructionId: "issue-implement",
        agent: "claude",
        requestedBy: "test",
      });

      const tasks = await store.listTasks();
      const queuedIds = tasks
        .filter((task) => task.status === "queued")
        .map((task) => task.taskId);

      assert.deepEqual(queuedIds, [a.taskId, b.taskId, c.taskId]);
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
      assert.deepEqual(await readdir(join(root, "running")), [
        `${task.taskId}.json`,
      ]);
      assert.deepEqual(await readdir(join(root, "queued")), []);

      await store.completeTask(task.taskId, { status: "succeeded" });

      const reloadedTask = await store.getTask(task.taskId);
      assert.equal(reloadedTask?.status, "succeeded");
      assert.equal(reloadedTask?.instructionRevision, 1);
      assert.equal(typeof reloadedTask?.startedAt, "string");
      assert.equal(typeof reloadedTask?.finishedAt, "string");

      assert.deepEqual(await readdir(join(root, "running")), []);
      assert.deepEqual(await readdir(join(root, "succeeded")), [
        `${task.taskId}.json`,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("migrates legacy tasks.json into per-status directories on first use", async () => {
    const root = await mkdtemp(join(tmpdir(), "queue-store-"));

    try {
      const legacyRecords = [
        {
          taskId: "task_q",
          repo: { owner: "octo", name: "repo" },
          source: { kind: "issue", number: 100 },
          instructionId: "issue-comment-reply",
          // Legacy record without an agent field — must default to claude.
          status: "queued",
          priority: "normal",
          requestedBy: "test",
          createdAt: "2026-04-24T00:00:00.000Z",
        },
        {
          taskId: "task_done",
          repo: { owner: "octo", name: "repo" },
          source: { kind: "pull_request", number: 7 },
          instructionId: "pr-review",
          agent: "claude",
          status: "succeeded",
          priority: "normal",
          requestedBy: "test",
          createdAt: "2026-04-23T00:00:00.000Z",
          startedAt: "2026-04-23T00:00:01.000Z",
          finishedAt: "2026-04-23T00:00:30.000Z",
        },
      ];
      const legacyPath = join(root, "tasks.json");
      await writeFile(legacyPath, JSON.stringify(legacyRecords, null, 2));

      const store = new FileQueueStore({ dataDir: root });
      const tasks = await store.listTasks();

      assert.equal(tasks.length, 2);
      const queued = tasks.find((t) => t.taskId === "task_q");
      const succeeded = tasks.find((t) => t.taskId === "task_done");
      assert.equal(queued?.status, "queued");
      assert.equal(queued?.agent, "claude");
      assert.equal(succeeded?.status, "succeeded");

      assert.deepEqual(await readdir(join(root, "queued")), ["task_q.json"]);
      assert.deepEqual(await readdir(join(root, "succeeded")), [
        "task_done.json",
      ]);

      const rootEntries = await readdir(root);
      assert.ok(rootEntries.includes("tasks.json.migrated"));
      assert.ok(!rootEntries.includes("tasks.json"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("revertToQueued resets a running task back to queued and clears revision", async () => {
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
      const reverted = await store.revertToQueued(task.taskId);

      assert.equal(reverted.status, "queued");
      assert.equal(reverted.instructionRevision, undefined);
      assert.equal(reverted.startedAt, undefined);
      assert.equal(reverted.finishedAt, undefined);
      assert.equal(reverted.errorSummary, undefined);

      const reloaded = await store.getTask(task.taskId);
      assert.equal(reloaded?.status, "queued");

      assert.deepEqual(await readdir(join(root, "running")), []);
      assert.deepEqual(await readdir(join(root, "queued")), [
        `${task.taskId}.json`,
      ]);

      // Cleared optional fields must be absent on disk, not just undefined
      // in memory.
      const onDisk = JSON.parse(
        await readFile(join(root, "queued", `${task.taskId}.json`), "utf8"),
      );
      assert.equal("instructionRevision" in onDisk, false);
      assert.equal("startedAt" in onDisk, false);
      assert.equal("finishedAt" in onDisk, false);
      assert.equal("errorSummary" in onDisk, false);
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

      assert.deepEqual(await readdir(join(root, "running")), []);
      assert.deepEqual(await readdir(join(root, "failed")), [
        `${task.taskId}.json`,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("pruneTerminalTasks removes terminal files older than cutoff and leaves active ones alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "queue-store-"));

    try {
      const store = new FileQueueStore({ dataDir: root });

      // An old completed task and an old failed task.
      const oldDone = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 1 },
        instructionId: "issue-implement",
        agent: "claude",
        requestedBy: "test",
      });
      await store.startTask(oldDone.taskId, 1);
      await store.completeTask(oldDone.taskId, { status: "succeeded" });

      const oldFailed = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 2 },
        instructionId: "issue-implement",
        agent: "claude",
        requestedBy: "test",
      });
      await store.startTask(oldFailed.taskId, 1);
      await store.completeTask(oldFailed.taskId, {
        status: "failed",
        errorSummary: "boom",
      });

      // Backdate their mtimes to 10 days ago.
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      await utimes(
        join(root, "succeeded", `${oldDone.taskId}.json`),
        tenDaysAgo,
        tenDaysAgo,
      );
      await utimes(
        join(root, "failed", `${oldFailed.taskId}.json`),
        tenDaysAgo,
        tenDaysAgo,
      );

      // A fresh terminal task and a fresh queued task — both should survive.
      const recentDone = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 3 },
        instructionId: "issue-implement",
        agent: "claude",
        requestedBy: "test",
      });
      await store.startTask(recentDone.taskId, 1);
      await store.completeTask(recentDone.taskId, { status: "succeeded" });

      const stillQueued = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 4 },
        instructionId: "issue-implement",
        agent: "claude",
        requestedBy: "test",
      });

      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const pruned = await store.pruneTerminalTasks(cutoff);

      assert.equal(pruned, 2);
      assert.deepEqual(await readdir(join(root, "succeeded")), [
        `${recentDone.taskId}.json`,
      ]);
      assert.deepEqual(await readdir(join(root, "failed")), []);
      // Active state must never be touched, regardless of mtime/cutoff.
      assert.deepEqual(await readdir(join(root, "queued")), [
        `${stillQueued.taskId}.json`,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("status transitions land in exactly one directory at a time", async () => {
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

      const allDirs = ["queued", "running", "succeeded", "failed", "superseded"] as const;

      const countOccurrences = async (id: string): Promise<number> => {
        let count = 0;
        for (const dir of allDirs) {
          const entries = await readdir(join(root, dir)).catch(
            () => [] as string[],
          );
          if (entries.includes(`${id}.json`)) {
            count += 1;
          }
        }
        return count;
      };

      assert.equal(await countOccurrences(task.taskId), 1);
      await store.startTask(task.taskId, 1);
      assert.equal(await countOccurrences(task.taskId), 1);
      await store.completeTask(task.taskId, { status: "succeeded" });
      assert.equal(await countOccurrences(task.taskId), 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
