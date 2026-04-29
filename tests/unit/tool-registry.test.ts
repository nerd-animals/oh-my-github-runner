import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ToolRunner } from "../../src/domain/ports/tool-runner.js";
import {
  ToolRegistry,
  loadToolConfigFromEnv,
  normalizeToolName,
} from "../../src/services/tool-registry.js";

const stubRunner: ToolRunner = {
  run: async () => ({ kind: "succeeded", stdout: "" }),
};

describe("normalizeToolName", () => {
  test("uppercases and replaces hyphens with underscores", () => {
    assert.equal(normalizeToolName("claude"), "CLAUDE");
    assert.equal(normalizeToolName("codex-cli"), "CODEX_CLI");
    assert.equal(normalizeToolName("foo-bar-baz"), "FOO_BAR_BAZ");
  });
});

describe("ToolRegistry", () => {
  test("resolves a registered tool runner", () => {
    const registry = new ToolRegistry([{ name: "claude", runner: stubRunner }]);

    assert.equal(registry.resolve("claude"), stubRunner);
    assert.equal(registry.has("claude"), true);
    assert.deepEqual(registry.listTools(), ["claude"]);
  });

  test("throws when resolving an unknown tool", () => {
    const registry = new ToolRegistry([{ name: "claude", runner: stubRunner }]);

    assert.throws(() => registry.resolve("codex"), /Unknown tool: codex/);
  });
});

describe("loadToolConfigFromEnv", () => {
  test("parses a single-tool env block", () => {
    const config = loadToolConfigFromEnv({
      AGENTS: "claude",
      CLAUDE_COMMAND: "/usr/local/bin/claude",
      CLAUDE_ARGS_JSON: '["-p"]',
    });

    assert.deepEqual(config.tools, ["claude"]);
    assert.deepEqual(config.commands.claude, {
      command: "/usr/local/bin/claude",
      args: ["-p"],
    });
  });

  test("normalizes hyphenated tool names to env var prefixes", () => {
    const config = loadToolConfigFromEnv({
      AGENTS: "codex-cli",
      "CODEX_CLI_COMMAND": "/usr/local/bin/codex",
    });

    assert.deepEqual(config.commands["codex-cli"], {
      command: "/usr/local/bin/codex",
      args: [],
    });
  });

  test("rejects missing AGENTS env", () => {
    assert.throws(
      () => loadToolConfigFromEnv({}),
      /Missing required environment variable: AGENTS/,
    );
  });

  test("rejects missing per-tool COMMAND env", () => {
    assert.throws(
      () =>
        loadToolConfigFromEnv({
          AGENTS: "claude",
        }),
      /Missing required environment variable: CLAUDE_COMMAND/,
    );
  });
});
