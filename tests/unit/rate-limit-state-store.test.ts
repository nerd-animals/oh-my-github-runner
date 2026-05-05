import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  test("filters out expired entries without rewriting the file", async () => {
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

      const beforeLoad = await readFile(filePath, "utf8");

      const reader = new RateLimitStateStore({
        filePath,
        now: () => 2_000,
      });
      const active = await reader.loadActivePauses();

      assert.equal(active.has("claude"), false);
      assert.equal(active.get("codex"), future);

      const afterLoad = await readFile(filePath, "utf8");
      assert.equal(afterLoad, beforeLoad);

      const onDisk = JSON.parse(afterLoad) as {
        pauses: Record<string, number>;
      };
      assert.deepEqual(Object.keys(onDisk.pauses).sort(), ["claude", "codex"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns empty pauses and warns when state.json is corrupt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rate-state-"));

    try {
      const filePath = join(dir, "state.json");
      // Half-written JSON that JSON.parse cannot consume — the case the
      // issue describes (non-graceful shutdown leaving the file truncated).
      await writeFile(filePath, '{ "pauses": { "claude":', "utf8");

      const warnings: string[] = [];
      const store = new RateLimitStateStore({
        filePath,
        warn: (message) => warnings.push(message),
      });

      const active = await store.loadActivePauses();

      assert.equal(active.size, 0);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? "", /corrupt state file/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves all concurrent pauses on a single store instance (single-process singleton)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rate-state-"));

    try {
      const filePath = join(dir, "state.json");
      const store = new RateLimitStateStore({
        filePath,
        now: () => 1_000_000,
      });

      // Without RMW serialization, the two pauses can interleave their
      // read-modify-write cycles and the second writer overwrites the first.
      await Promise.all([
        store.pause("claude", 1_500_000),
        store.pause("codex", 1_600_000),
      ]);

      const reader = new RateLimitStateStore({
        filePath,
        now: () => 1_000_500,
      });
      const active = await reader.loadActivePauses();

      assert.equal(active.get("claude"), 1_500_000);
      assert.equal(active.get("codex"), 1_600_000);
      assert.equal(active.size, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves all concurrent pauses across many tools", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rate-state-"));

    try {
      const filePath = join(dir, "state.json");
      const store = new RateLimitStateStore({
        filePath,
        now: () => 0,
      });

      const tools = Array.from({ length: 16 }, (_, i) => `tool-${i}`);
      await Promise.all(
        tools.map((tool, i) => store.pause(tool, 1_000_000 + i)),
      );

      const reader = new RateLimitStateStore({ filePath, now: () => 0 });
      const active = await reader.loadActivePauses();

      assert.equal(active.size, tools.length);
      for (const [i, tool] of tools.entries()) {
        assert.equal(active.get(tool), 1_000_000 + i);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("clear() returns the previous pausedUntil and removes the entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rate-state-"));

    try {
      const filePath = join(dir, "state.json");
      const writer = new RateLimitStateStore({
        filePath,
        now: () => 1_000_000,
      });

      await writer.pause("claude", 1_500_000);

      const cleared = await writer.clear("claude");
      assert.equal(cleared, 1_500_000);

      const reader = new RateLimitStateStore({
        filePath,
        now: () => 1_000_500,
      });
      const active = await reader.loadActivePauses();
      assert.equal(active.has("claude"), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("clear() is idempotent and returns undefined when no pause is tracked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rate-state-"));

    try {
      const store = new RateLimitStateStore({
        filePath: join(dir, "state.json"),
      });

      const result = await store.clear("claude");
      assert.equal(result, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("clear() leaves other tools' pauses intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rate-state-"));

    try {
      const filePath = join(dir, "state.json");
      const store = new RateLimitStateStore({
        filePath,
        now: () => 1_000_000,
      });

      await store.pause("claude", 1_500_000);
      await store.pause("codex", 1_600_000);

      const cleared = await store.clear("claude");
      assert.equal(cleared, 1_500_000);

      const active = await store.loadActivePauses();
      assert.equal(active.has("claude"), false);
      assert.equal(active.get("codex"), 1_600_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recovers cleanly after a corrupt state.json so subsequent pauses persist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rate-state-"));

    try {
      const filePath = join(dir, "state.json");
      await writeFile(filePath, "not-json-at-all", "utf8");

      const warnings: string[] = [];
      const store = new RateLimitStateStore({
        filePath,
        now: () => 1_000_000,
        warn: (message) => warnings.push(message),
      });

      // First load triggers the recovery path.
      const initiallyActive = await store.loadActivePauses();
      assert.equal(initiallyActive.size, 0);

      await store.pause("claude", 1_500_000);

      // The file must now be valid JSON that a fresh reader can consume.
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

  test("pause max-merges: a longer existing pausedUntil wins over a shorter incoming one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rate-state-"));
    try {
      const filePath = join(dir, "state.json");
      const store = new RateLimitStateStore({
        filePath,
        now: () => 1_000_000,
      });

      // GitHub fetch wrapper writes a precise far-future pause from the
      // X-RateLimit-Reset header.
      await store.pause("github", 5_000_000);

      // Daemon's handleRateLimit follows up with its standard cooldown
      // floor (a closer time). Without max-merge this would shorten the
      // pause and the next tick would re-trigger 429.
      await store.pause("github", 2_000_000);

      const active = await store.loadActivePauses();
      assert.equal(active.get("github"), 5_000_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("pause max-merges: a later, longer pausedUntil overrides an earlier shorter one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rate-state-"));
    try {
      const filePath = join(dir, "state.json");
      const store = new RateLimitStateStore({
        filePath,
        now: () => 1_000_000,
      });

      await store.pause("github", 2_000_000);
      // Then a fresh, longer 429 (more strict) — that one must win.
      await store.pause("github", 5_000_000);

      const active = await store.loadActivePauses();
      assert.equal(active.get("github"), 5_000_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("pause overwrites a stale (already-expired) entry with a fresh future timestamp", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rate-state-"));
    try {
      const filePath = join(dir, "state.json");
      const writer = new RateLimitStateStore({
        filePath,
        now: () => 1_000_000,
      });
      // Stale pause in the past (e.g. pre-restart).
      await writer.pause("claude", 500);

      const fresh = new RateLimitStateStore({
        filePath,
        now: () => 1_000_000,
      });
      // Fresh future pause must replace the stale one even though the
      // stale value is numerically smaller — max(500, 1_500_000) = 1_500_000.
      await fresh.pause("claude", 1_500_000);

      const active = await fresh.loadActivePauses();
      assert.equal(active.get("claude"), 1_500_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
