import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { FileCheckpointStore } from "../../src/infra/checkpoint/file-checkpoint-store.js";

function fileNameFor(stepKey: string): string {
  return `${createHash("sha256").update(stepKey).digest("hex").slice(0, 16)}.json`;
}

function makeEntry(overrides: {
  stepKey?: string;
  fingerprint?: string;
  tool?: string;
  stdout?: string;
} = {}) {
  return {
    stepKey: overrides.stepKey ?? "persona/architect",
    fingerprint: overrides.fingerprint ?? "fp-1",
    tool: overrides.tool ?? "claude",
    succeededAt: "2026-05-05T12:00:00.000Z",
    stdout: overrides.stdout ?? "analysis output",
  };
}

describe("FileCheckpointStore", () => {
  test("write then read returns the same entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkpoint-store-"));
    try {
      const store = new FileCheckpointStore({ dataDir: root });
      const entry = makeEntry();
      await store.write("task_1", entry);
      const got = await store.read("task_1", entry.stepKey);
      assert.deepEqual(got, entry);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("read on a non-existent task returns undefined", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkpoint-store-"));
    try {
      const store = new FileCheckpointStore({ dataDir: root });
      const got = await store.read("task_missing", "step/x");
      assert.equal(got, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("read on a task with no matching stepKey returns undefined", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkpoint-store-"));
    try {
      const store = new FileCheckpointStore({ dataDir: root });
      await store.write("task_1", makeEntry({ stepKey: "step/a" }));
      const got = await store.read("task_1", "step/b");
      assert.equal(got, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("write is atomic — no .tmp file remains after success", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkpoint-store-"));
    try {
      const store = new FileCheckpointStore({ dataDir: root });
      await store.write("task_1", makeEntry());
      const files = await readdir(join(root, "task_1"));
      assert.ok(
        !files.some((f) => f.endsWith(".tmp")),
        `unexpected .tmp file: ${files.join(",")}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("concurrent writes to different stepKeys in the same task all succeed", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkpoint-store-"));
    try {
      const store = new FileCheckpointStore({ dataDir: root });
      const stepKeys = ["s1", "s2", "s3", "s4"];
      await Promise.all(
        stepKeys.map((stepKey) =>
          store.write("task_1", makeEntry({ stepKey, stdout: stepKey })),
        ),
      );
      for (const stepKey of stepKeys) {
        const got = await store.read("task_1", stepKey);
        assert.equal(got?.stdout, stepKey);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("re-writing the same stepKey overwrites (last write wins)", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkpoint-store-"));
    try {
      const store = new FileCheckpointStore({ dataDir: root });
      await store.write("task_1", makeEntry({ stdout: "v1" }));
      await store.write("task_1", makeEntry({ stdout: "v2" }));
      const got = await store.read("task_1", "persona/architect");
      assert.equal(got?.stdout, "v2");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("corrupt JSON is quarantined and read returns undefined", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkpoint-store-"));
    try {
      const warnings: string[] = [];
      const store = new FileCheckpointStore({
        dataDir: root,
        warn: (m) => warnings.push(m),
      });
      const stepKey = "step/corrupt";
      const corruptPath = join(root, "task_1", fileNameFor(stepKey));
      await mkdir(join(root, "task_1"), { recursive: true });
      await writeFile(corruptPath, "{ not valid json", "utf8");

      const got = await store.read("task_1", stepKey);
      assert.equal(got, undefined);

      // Original path should be empty after quarantine.
      const taskFiles = await readdir(join(root, "task_1"));
      assert.deepEqual(taskFiles, []);

      // Quarantine directory should now have the file.
      const corruptFiles = await readdir(join(root, "corrupt", "task_1"));
      assert.equal(corruptFiles.length, 1);
      assert.ok(warnings.some((w) => w.includes("quarantined corrupt")));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("malformed schema (missing required fields) is quarantined", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkpoint-store-"));
    try {
      const store = new FileCheckpointStore({
        dataDir: root,
        warn: () => {},
      });
      const stepKey = "step/bad";
      const filePath = join(root, "task_1", fileNameFor(stepKey));
      await mkdir(join(root, "task_1"), { recursive: true });
      await writeFile(
        filePath,
        JSON.stringify({ version: 1, stepKey: "step/bad" }),
        "utf8",
      );
      const got = await store.read("task_1", stepKey);
      assert.equal(got, undefined);
      const taskFiles = await readdir(join(root, "task_1"));
      assert.deepEqual(taskFiles, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("unknown version returns undefined without quarantining", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkpoint-store-"));
    try {
      const store = new FileCheckpointStore({
        dataDir: root,
        warn: () => {},
      });
      const stepKey = "step/futureproof";
      const filePath = join(root, "task_1", fileNameFor(stepKey));
      await mkdir(join(root, "task_1"), { recursive: true });
      await writeFile(
        filePath,
        JSON.stringify({
          version: 999,
          stepKey,
          fingerprint: "fp",
          tool: "claude",
          succeededAt: "2026-05-05T12:00:00.000Z",
          stdout: "...",
        }),
        "utf8",
      );
      const got = await store.read("task_1", stepKey);
      assert.equal(got, undefined);

      // No quarantine: the file should still be at its original path so a
      // subsequent successful write can overwrite it.
      const taskFiles = await readdir(join(root, "task_1"));
      assert.equal(taskFiles.length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("drop removes the entire task directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkpoint-store-"));
    try {
      const store = new FileCheckpointStore({ dataDir: root });
      await store.write("task_1", makeEntry({ stepKey: "a" }));
      await store.write("task_1", makeEntry({ stepKey: "b" }));
      await store.drop("task_1");
      const dirs = await readdir(root);
      assert.ok(!dirs.includes("task_1"), `task_1 still present: ${dirs}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("drop on a non-existent task is a no-op (does not throw)", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkpoint-store-"));
    try {
      const store = new FileCheckpointStore({ dataDir: root });
      await store.drop("task_never_existed");
      // No assertion needed — survival is the test.
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("sweep removes orphan task directories and keeps active ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkpoint-store-"));
    try {
      const store = new FileCheckpointStore({ dataDir: root });
      await store.write("task_active", makeEntry());
      await store.write("task_orphan_1", makeEntry());
      await store.write("task_orphan_2", makeEntry());

      const dropped = await store.sweep(new Set(["task_active"]));

      assert.equal(dropped, 2);
      const dirs = await readdir(root);
      assert.deepEqual(dirs.sort(), ["task_active"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("sweep does not remove the corrupt/ quarantine directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkpoint-store-"));
    try {
      const store = new FileCheckpointStore({
        dataDir: root,
        warn: () => {},
      });
      // Trigger a quarantine.
      const stepKey = "step/x";
      await mkdir(join(root, "task_1"), { recursive: true });
      await writeFile(
        join(root, "task_1", fileNameFor(stepKey)),
        "not json",
        "utf8",
      );
      await store.read("task_1", stepKey);

      // Sweep with no active tasks. Should remove task_1 but keep corrupt/.
      const dropped = await store.sweep(new Set());
      assert.equal(dropped, 1);
      const dirs = await readdir(root);
      assert.ok(dirs.includes("corrupt"));
      assert.ok(!dirs.includes("task_1"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("sweep on a missing dataDir returns 0 without throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkpoint-store-"));
    try {
      const missingDir = join(root, "does-not-exist");
      const store = new FileCheckpointStore({ dataDir: missingDir });
      const dropped = await store.sweep(new Set(["task_x"]));
      assert.equal(dropped, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("persisted file embeds version and round-trips fingerprint exactly", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkpoint-store-"));
    try {
      const store = new FileCheckpointStore({ dataDir: root });
      const entry = makeEntry({
        stepKey: "persona/test",
        fingerprint: "deadbeef",
        tool: "codex",
      });
      await store.write("task_1", entry);
      const filePath = join(root, "task_1", fileNameFor(entry.stepKey));
      const raw = await readFile(filePath, "utf8");
      const payload = JSON.parse(raw);
      assert.equal(payload.version, 1);
      assert.equal(payload.fingerprint, "deadbeef");
      assert.equal(payload.tool, "codex");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
