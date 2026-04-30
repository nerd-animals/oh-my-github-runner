import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ToolRunner } from "../../src/domain/ports/tool-runner.js";
import { ToolRegistry } from "../../src/services/tool-registry.js";

const stubRunner: ToolRunner = {
  run: async () => ({ kind: "succeeded", stdout: "" }),
  cleanupArtifacts: async () => {},
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
