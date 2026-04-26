import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadAgentRateLimitConfig } from "../../src/infra/agent/agent-rate-limit-config.js";

describe("loadAgentRateLimitConfig", () => {
  test("returns an empty config when the agent yaml does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-config-"));

    try {
      const config = await loadAgentRateLimitConfig(dir, "missing");

      assert.deepEqual(config.exitCodes, []);
      assert.deepEqual(config.stderrPatterns, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("parses exit_codes and stderr_patterns from yaml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-config-"));

    try {
      await writeFile(
        join(dir, "claude.yaml"),
        [
          "exit_codes: [137, 143]",
          "stderr_patterns:",
          "  - rate.?limit",
          "  - 429",
          "",
        ].join("\n"),
        "utf8",
      );

      const config = await loadAgentRateLimitConfig(dir, "claude");

      assert.deepEqual(config.exitCodes, [137, 143]);
      assert.equal(config.stderrPatterns.length, 2);
      assert.equal(config.stderrPatterns[0]?.test("rate-limit hit"), true);
      assert.equal(config.stderrPatterns[1]?.test("got 429 back"), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("treats an empty yaml file as an empty config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-config-"));

    try {
      await writeFile(join(dir, "claude.yaml"), "", "utf8");

      const config = await loadAgentRateLimitConfig(dir, "claude");

      assert.deepEqual(config.exitCodes, []);
      assert.deepEqual(config.stderrPatterns, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
