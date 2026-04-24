import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { FileLogStore } from "../../src/infra/logs/file-log-store.js";

describe("FileLogStore", () => {
  test("appends log entries to a task log file", async () => {
    const root = await mkdtemp(join(tmpdir(), "log-store-"));

    try {
      const store = new FileLogStore({
        logsDir: root,
        retentionMs: 3 * 24 * 60 * 60 * 1000,
      });

      await store.write("task_1", "starting");
      await store.write("task_1", "finished");

      const contents = await readFile(join(root, "task_1.log"), "utf8");

      assert.match(contents, /starting/);
      assert.match(contents, /finished/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes expired log files during cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "log-store-"));

    try {
      const store = new FileLogStore({
        logsDir: root,
        retentionMs: 60 * 60 * 1000,
      });

      const expiredFile = join(root, "expired.log");
      const freshFile = join(root, "fresh.log");

      await writeFile(expiredFile, "old", "utf8");
      await writeFile(freshFile, "new", "utf8");

      const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await utimes(expiredFile, oldDate, oldDate);

      await store.cleanupExpired();

      await assert.rejects(readFile(expiredFile, "utf8"));
      assert.equal(await readFile(freshFile, "utf8"), "new");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
