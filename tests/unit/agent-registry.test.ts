import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentRunner } from "../../src/domain/ports/agent-runner.js";
import {
  AgentRegistry,
  loadAgentConfigFromEnv,
  normalizeAgentName,
} from "../../src/services/agent-registry.js";

const stubRunner: AgentRunner = {
  run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
};

describe("normalizeAgentName", () => {
  test("uppercases and replaces hyphens with underscores", () => {
    assert.equal(normalizeAgentName("claude"), "CLAUDE");
    assert.equal(normalizeAgentName("codex-cli"), "CODEX_CLI");
    assert.equal(normalizeAgentName("foo-bar-baz"), "FOO_BAR_BAZ");
  });
});

describe("AgentRegistry", () => {
  test("resolves a registered agent runner", () => {
    const registry = new AgentRegistry(
      [{ name: "claude", runner: stubRunner }],
      "claude",
    );

    assert.equal(registry.resolve("claude"), stubRunner);
    assert.equal(registry.has("claude"), true);
    assert.equal(registry.getDefaultAgent(), "claude");
    assert.deepEqual(registry.listAgents(), ["claude"]);
  });

  test("throws when resolving an unknown agent", () => {
    const registry = new AgentRegistry(
      [{ name: "claude", runner: stubRunner }],
      "claude",
    );

    assert.throws(() => registry.resolve("codex"), /Unknown agent: codex/);
  });

  test("rejects a default agent that is not registered", () => {
    assert.throws(
      () =>
        new AgentRegistry([{ name: "claude", runner: stubRunner }], "codex"),
      /DEFAULT_AGENT 'codex' is not in the AGENTS registry/,
    );
  });
});

describe("loadAgentConfigFromEnv", () => {
  test("parses a single-agent env block", () => {
    const config = loadAgentConfigFromEnv({
      AGENTS: "claude",
      CLAUDE_COMMAND: "/usr/local/bin/claude",
      CLAUDE_ARGS_JSON: '["-p"]',
    });

    assert.deepEqual(config.agents, ["claude"]);
    assert.equal(config.defaultAgent, "claude");
    assert.deepEqual(config.commands.claude, {
      command: "/usr/local/bin/claude",
      args: ["-p"],
    });
  });

  test("normalizes hyphenated agent names to env var prefixes", () => {
    const config = loadAgentConfigFromEnv({
      AGENTS: "codex-cli",
      "CODEX_CLI_COMMAND": "/usr/local/bin/codex",
    });

    assert.deepEqual(config.commands["codex-cli"], {
      command: "/usr/local/bin/codex",
      args: [],
    });
  });

  test("uses the first agent as the default when DEFAULT_AGENT is unset", () => {
    const config = loadAgentConfigFromEnv({
      AGENTS: "claude,codex",
      CLAUDE_COMMAND: "/usr/local/bin/claude",
      CODEX_COMMAND: "/usr/local/bin/codex",
    });

    assert.equal(config.defaultAgent, "claude");
  });

  test("honors DEFAULT_AGENT when set", () => {
    const config = loadAgentConfigFromEnv({
      AGENTS: "claude,codex",
      DEFAULT_AGENT: "codex",
      CLAUDE_COMMAND: "/usr/local/bin/claude",
      CODEX_COMMAND: "/usr/local/bin/codex",
    });

    assert.equal(config.defaultAgent, "codex");
  });

  test("rejects DEFAULT_AGENT not in AGENTS", () => {
    assert.throws(
      () =>
        loadAgentConfigFromEnv({
          AGENTS: "claude",
          DEFAULT_AGENT: "codex",
          CLAUDE_COMMAND: "/usr/local/bin/claude",
        }),
      /DEFAULT_AGENT 'codex' must be one of AGENTS/,
    );
  });

  test("rejects missing AGENTS env", () => {
    assert.throws(
      () => loadAgentConfigFromEnv({}),
      /Missing required environment variable: AGENTS/,
    );
  });

  test("rejects missing per-agent COMMAND env", () => {
    assert.throws(
      () =>
        loadAgentConfigFromEnv({
          AGENTS: "claude",
        }),
      /Missing required environment variable: CLAUDE_COMMAND/,
    );
  });
});
