import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { RateLimitStateStore } from "../../src/infra/queue/rate-limit-state-store.js";

describe("RateLimitStateStore", () => {
  test("returns an empty map when the file does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rate-state-"));

    try {
      const store = new RateLimitStateStore({
        filePath: join(dir, "state.json"),
      });

      const active = await store.loadActivePauses();

      assert.equal(active.size, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("persists and loads pauses across instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rate-state-"));

    try {
      const filePath = join(dir, "state.json");
      const writer = new RateLimitStateStore({
        filePath,
        now: () => 1_000_000,
      });

      await writer.pause("claude", 1_500_000);

      const reader = new RateLimitStateStore({
        filePath,
        now: () => 1_000_500,
      });
      const active = await reader.loadActivePauses();

      assert.equal(active.get("claude"), 1_500_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("drops expired entries on load and rewrites the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rate-state-"));

    try {
      const filePath = join(dir, "state.json");
      const past = 1_000;
      const future = 5_000;

      const writer = new RateLimitStateStore({
        filePath,
        now: () => 0,
      });
      await writer.pause("claude", past);
      await writer.pause("codex", future);

      const reader = new RateLimitStateStore({
        filePath,
        now: () => 2_000,
      });
      const active = await reader.loadActivePauses();

      assert.equal(active.has("claude"), false);
      assert.equal(active.get("codex"), future);

      const onDisk = JSON.parse(await readFile(filePath, "utf8")) as {
        pauses: Record<string, number>;
      };
      assert.deepEqual(Object.keys(onDisk.pauses), ["codex"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
