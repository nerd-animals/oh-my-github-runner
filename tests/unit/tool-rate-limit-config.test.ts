import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadToolRateLimitConfig } from "../../src/infra/tool/tool-rate-limit-config.js";

describe("loadToolRateLimitConfig", () => {
  test("returns an empty config when the tool yaml does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-config-"));

    try {
      const config = await loadToolRateLimitConfig(dir, "missing");

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

      const config = await loadToolRateLimitConfig(dir, "claude");

      assert.deepEqual(config.exitCodes, [137, 143]);
      assert.equal(config.stderrPatterns.length, 2);
      assert.equal(config.stderrPatterns[0]?.test("rate-limit hit"), true);
      assert.equal(config.stderrPatterns[1]?.test("got 429 back"), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the shipped claude.yaml matches both observed rate-limit phrasings", async () => {
    const config = await loadToolRateLimitConfig(
      "definitions/tools",
      "claude",
    );

    const orgLimit = "You've hit your org's monthly usage limit";
    const userLimit = "You've hit your limit 쨌 resets 11:30am (UTC)";
    const jsonEnvelope = '"api_error_status": 429,';

    const matches = (sample: string): boolean =>
      config.stderrPatterns.some((pattern) => pattern.test(sample));

    assert.equal(matches(orgLimit), true);
    assert.equal(matches(userLimit), true);
    assert.equal(matches(jsonEnvelope), true);
    assert.equal(matches("hi there, no rate limit here"), false);
  });

  test("treats an empty yaml file as an empty config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-config-"));

    try {
      await writeFile(join(dir, "claude.yaml"), "", "utf8");

      const config = await loadToolRateLimitConfig(dir, "claude");

      assert.deepEqual(config.exitCodes, []);
      assert.deepEqual(config.stderrPatterns, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
