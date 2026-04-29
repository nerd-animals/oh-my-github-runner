import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadToolDescriptor } from "../../src/infra/tool/tool-descriptor.js";

describe("loadToolDescriptor", () => {
  test("returns an empty descriptor when the tool yaml does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-config-"));

    try {
      const descriptor = await loadToolDescriptor(dir, "missing");

      assert.deepEqual(descriptor.args, []);
      assert.deepEqual(descriptor.rateLimit.exitCodes, []);
      assert.deepEqual(descriptor.rateLimit.stderrPatterns, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("parses args, exit_codes and stderr_patterns from yaml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-config-"));

    try {
      await writeFile(
        join(dir, "claude.yaml"),
        [
          'args: ["-p", "--output-format", "json"]',
          "exit_codes: [137, 143]",
          "stderr_patterns:",
          "  - rate.?limit",
          "  - 429",
          "",
        ].join("\n"),
        "utf8",
      );

      const descriptor = await loadToolDescriptor(dir, "claude");

      assert.deepEqual(descriptor.args, ["-p", "--output-format", "json"]);
      assert.deepEqual(descriptor.rateLimit.exitCodes, [137, 143]);
      assert.equal(descriptor.rateLimit.stderrPatterns.length, 2);
      assert.equal(
        descriptor.rateLimit.stderrPatterns[0]?.test("rate-limit hit"),
        true,
      );
      assert.equal(
        descriptor.rateLimit.stderrPatterns[1]?.test("got 429 back"),
        true,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the shipped claude.yaml carries args and rate-limit patterns", async () => {
    const descriptor = await loadToolDescriptor("definitions/tools", "claude");

    assert.deepEqual(descriptor.args, ["-p"]);

    const orgLimit = "You've hit your org's monthly usage limit";
    const userLimit = "You've hit your limit 쨌 resets 11:30am (UTC)";
    const jsonEnvelope = '"api_error_status": 429,';

    const matches = (sample: string): boolean =>
      descriptor.rateLimit.stderrPatterns.some((pattern) =>
        pattern.test(sample),
      );

    assert.equal(matches(orgLimit), true);
    assert.equal(matches(userLimit), true);
    assert.equal(matches(jsonEnvelope), true);
    assert.equal(matches("hi there, no rate limit here"), false);
  });

  test("treats an empty yaml file as an empty descriptor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-config-"));

    try {
      await writeFile(join(dir, "claude.yaml"), "", "utf8");

      const descriptor = await loadToolDescriptor(dir, "claude");

      assert.deepEqual(descriptor.args, []);
      assert.deepEqual(descriptor.rateLimit.exitCodes, []);
      assert.deepEqual(descriptor.rateLimit.stderrPatterns, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
