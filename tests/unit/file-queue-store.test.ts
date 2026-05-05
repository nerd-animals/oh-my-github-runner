import assert from "node:assert/strict";
import {
  mkdir,
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

  test("findQueuedBySource returns only queued tasks matching the source and excludes running tasks", async () => {
    const root = await mkdtemp(join(tmpdir(), "queue-store-"));

    try {
      const store = new FileQueueStore({ dataDir: root });
      const queuedSame = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 100 },
        instructionId: "issue-implement",
        requestedBy: "test",
      });
      const runningSame = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 100 },
        instructionId: "issue-implement",
        requestedBy: "test",
      });
      const queuedDifferent = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 200 },
        instructionId: "issue-implement",
        requestedBy: "test",
      });
      await store.startTask(runningSame.taskId);

      const matches = await store.findQueuedBySource(
        { owner: "octo", name: "repo" },
        { kind: "issue", number: 100 },
      );

      assert.deepEqual(
        matches.map((task) => task.taskId),
        [queuedSame.taskId],
      );
      assert.equal(
        matches.some((task) => task.taskId === runningSame.taskId),
        false,
        "running task on the same source must not be returned",
      );
      assert.equal(
        matches.some((task) => task.taskId === queuedDifferent.taskId),
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("markSuperseded moves a queued task into superseded with supersededBy", async () => {
    const root = await mkdtemp(join(tmpdir(), "queue-store-"));

    try {
      const store = new FileQueueStore({ dataDir: root });
      const old = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 100 },
        instructionId: "issue-implement",
        requestedBy: "test",
      });

      const result = await store.markSuperseded(old.taskId, "task_new");

      assert.equal(result.status, "superseded");
      assert.equal(result.supersededBy, "task_new");
      assert.equal(typeof result.finishedAt, "string");

      assert.deepEqual(await readdir(join(root, "queued")), []);
      assert.deepEqual(await readdir(join(root, "superseded")), [
        `${old.taskId}.json`,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("markSuperseded rejects a running task and leaves it in running/", async () => {
    const root = await mkdtemp(join(tmpdir(), "queue-store-"));

    try {
      const store = new FileQueueStore({ dataDir: root });
      const old = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 100 },
        instructionId: "issue-implement",
        requestedBy: "test",
      });
      await store.startTask(old.taskId);

      await assert.rejects(
        () => store.markSuperseded(old.taskId, "task_new"),
        /not in queued status/i,
      );

      assert.deepEqual(await readdir(join(root, "running")), [
        `${old.taskId}.json`,
      ]);
      // Nothing should have moved into superseded/.
      const supersededEntries = await readdir(
        join(root, "superseded"),
      ).catch(() => [] as string[]);
      assert.deepEqual(supersededEntries, []);
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
        requestedBy: "test",
      });
      const b = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 2 },
        instructionId: "issue-implement",
        requestedBy: "test",
      });
      const c = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 3 },
        instructionId: "issue-implement",
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
        requestedBy: "test",
      });

      await store.startTask(task.taskId);
      assert.deepEqual(await readdir(join(root, "running")), [
        `${task.taskId}.json`,
      ]);
      assert.deepEqual(await readdir(join(root, "queued")), []);

      await store.completeTask(task.taskId, { status: "succeeded" });

      const reloadedTask = await store.getTask(task.taskId);
      assert.equal(reloadedTask?.status, "succeeded");
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

  test("revertToQueued resets a running task back to queued", async () => {
    const root = await mkdtemp(join(tmpdir(), "queue-store-"));

    try {
      const store = new FileQueueStore({ dataDir: root });
      const task = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 100 },
        instructionId: "issue-implement",
        requestedBy: "test",
      });

      await store.startTask(task.taskId);
      const reverted = await store.revertToQueued(task.taskId);

      assert.equal(reverted.status, "queued");
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
        requestedBy: "test",
      });

      await store.startTask(task.taskId);
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
        requestedBy: "test",
      });
      await store.startTask(oldDone.taskId);
      await store.completeTask(oldDone.taskId, { status: "succeeded" });

      const oldFailed = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 2 },
        instructionId: "issue-implement",
        requestedBy: "test",
      });
      await store.startTask(oldFailed.taskId);
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
        requestedBy: "test",
      });
      await store.startTask(recentDone.taskId);
      await store.completeTask(recentDone.taskId, { status: "succeeded" });

      const stillQueued = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 4 },
        instructionId: "issue-implement",
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
      await store.startTask(task.taskId);
      assert.equal(await countOccurrences(task.taskId), 1);
      await store.completeTask(task.taskId, { status: "succeeded" });
      assert.equal(await countOccurrences(task.taskId), 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("listTasks does not throw when a queued task file is corrupt and quarantines it", async () => {
    const root = await mkdtemp(join(tmpdir(), "queue-store-"));

    try {
      const warnings: string[] = [];
      const store = new FileQueueStore({
        dataDir: root,
        warn: (message) => warnings.push(message),
      });

      const healthy = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 1 },
        instructionId: "issue-implement",
        requestedBy: "test",
      });

      // Plant a half-written task JSON next to the healthy one. This is
      // the failure mode the issue describes: a non-graceful shutdown
      // leaves a truncated file that JSON.parse cannot consume.
      const corruptId = "task_corrupt_abc";
      await mkdir(join(root, "queued"), { recursive: true });
      await writeFile(
        join(root, "queued", `${corruptId}.json`),
        '{ "taskId": "task_corrupt_abc", "status":',
        "utf8",
      );

      const tasks = await store.listTasks();

      assert.deepEqual(
        tasks.map((task) => task.taskId),
        [healthy.taskId],
      );

      // Corrupt file is gone from queued/...
      const queuedEntries = await readdir(join(root, "queued"));
      assert.deepEqual(queuedEntries, [`${healthy.taskId}.json`]);

      // ...and preserved under corrupt/queued/ for forensic recovery.
      const quarantined = await readdir(join(root, "corrupt", "queued"));
      assert.equal(quarantined.length, 1);
      assert.match(quarantined[0] ?? "", new RegExp(`^${corruptId}\\.`));

      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? "", /quarantined corrupt task file/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("getTask returns undefined for a corrupt task and quarantines it", async () => {
    const root = await mkdtemp(join(tmpdir(), "queue-store-"));

    try {
      const store = new FileQueueStore({
        dataDir: root,
        warn: () => {},
      });

      const corruptId = "task_corrupt_def";
      await mkdir(join(root, "running"), { recursive: true });
      await writeFile(
        join(root, "running", `${corruptId}.json`),
        "",
        "utf8",
      );

      const result = await store.getTask(corruptId);

      assert.equal(result, undefined);

      const runningEntries = await readdir(join(root, "running"));
      assert.deepEqual(runningEntries, []);

      const quarantined = await readdir(join(root, "corrupt", "running"));
      assert.equal(quarantined.length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recoverRunningTasks skips corrupt files and recovers the healthy ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "queue-store-"));

    try {
      const store = new FileQueueStore({
        dataDir: root,
        warn: () => {},
      });

      const healthy = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 7 },
        instructionId: "issue-implement",
        requestedBy: "test",
      });
      await store.startTask(healthy.taskId);

      // A second running task whose JSON is corrupt — the case that was
      // bricking daemon startup before this fix.
      await writeFile(
        join(root, "running", "task_corrupt_xyz.json"),
        "{not json",
        "utf8",
      );

      await store.recoverRunningTasks("daemon interrupted before completion");

      const reloaded = await store.getTask(healthy.taskId);
      assert.equal(reloaded?.status, "failed");
      assert.equal(
        reloaded?.errorSummary,
        "daemon interrupted before completion",
      );

      assert.deepEqual(await readdir(join(root, "running")), []);

      const quarantined = await readdir(join(root, "corrupt", "running"));
      assert.equal(quarantined.length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("listTasks preserves FIFO order for healthy tasks even with a corrupt sibling", async () => {
    const root = await mkdtemp(join(tmpdir(), "queue-store-"));

    try {
      const store = new FileQueueStore({
        dataDir: root,
        warn: () => {},
      });

      const a = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 1 },
        instructionId: "issue-implement",
        requestedBy: "test",
      });
      const b = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 2 },
        instructionId: "issue-implement",
        requestedBy: "test",
      });
      const c = await store.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "issue", number: 3 },
        instructionId: "issue-implement",
        requestedBy: "test",
      });

      await writeFile(
        join(root, "queued", "task_corrupt_mid.json"),
        "broken",
        "utf8",
      );

      const tasks = await store.listTasks();
      const queuedIds = tasks
        .filter((task) => task.status === "queued")
        .map((task) => task.taskId);

      assert.deepEqual(queuedIds, [a.taskId, b.taskId, c.taskId]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
