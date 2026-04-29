import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ToolRunner } from "../../src/domain/ports/tool-runner.js";
import {
  ToolRegistry,
  loadToolConfigFromEnv,
} from "../../src/services/tool-registry.js";

const stubRunner: ToolRunner = {
  run: async () => ({ kind: "succeeded", stdout: "" }),
};

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
  test("enables a known tool when its <NAME>_COMMAND is set", () => {
    const config = loadToolConfigFromEnv({
      CLAUDE_COMMAND: "/usr/local/bin/claude",
    });

    assert.deepEqual(config.tools, ["claude"]);
    assert.equal(config.commands.claude, "/usr/local/bin/claude");
  });

  test("ignores an empty <NAME>_COMMAND value", () => {
    assert.throws(
      () => loadToolConfigFromEnv({ CLAUDE_COMMAND: "" }),
      /No tool enabled/,
    );
  });

  test("throws when no <NAME>_COMMAND is set for any known tool", () => {
    assert.throws(() => loadToolConfigFromEnv({}), /No tool enabled/);
  });
});
