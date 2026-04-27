import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentRunInput, AgentRunResult } from "../../src/domain/agent.js";
import type { InstructionDefinition } from "../../src/domain/instruction.js";
import type { TaskRecord } from "../../src/domain/task.js";
import type { AgentRunner } from "../../src/domain/ports/agent-runner.js";
import { RateLimitDetectingAgentRunner } from "../../src/infra/agent/rate-limit-detecting-agent-runner.js";

const stubInput: AgentRunInput = {
  task: {} as TaskRecord,
  instruction: {} as InstructionDefinition,
  workspacePath: "/tmp",
  prompt: "",
};

function innerWith(result: AgentRunResult): AgentRunner {
  return { run: async () => result };
}

describe("RateLimitDetectingAgentRunner", () => {
  test("passes a successful inner result through unchanged", async () => {
    const runner = new RateLimitDetectingAgentRunner({
      inner: innerWith({ kind: "succeeded", stdout: "ok" }),
      agentName: "claude",
      config: { exitCodes: [], stderrPatterns: [] },
    });

    const result = await runner.run(stubInput);

    assert.equal(result.kind, "succeeded");
  });

  test("returns a rate_limited result when the exit code matches", async () => {
    const runner = new RateLimitDetectingAgentRunner({
      inner: innerWith({
        kind: "failed",
        exitCode: 137,
        stdout: "",
        stderr: "killed",
      }),
      agentName: "claude",
      config: { exitCodes: [137], stderrPatterns: [] },
    });

    const result = await runner.run(stubInput);

    assert.equal(result.kind, "rate_limited");
    if (result.kind !== "rate_limited") return;
    assert.equal(result.agentName, "claude");
    assert.match(result.signal, /exit_code=137/);
  });

  test("returns a rate_limited result when a stderr pattern matches", async () => {
    const runner = new RateLimitDetectingAgentRunner({
      inner: innerWith({
        kind: "failed",
        exitCode: 1,
        stdout: "",
        stderr: "Anthropic API: 429 Too Many Requests",
      }),
      agentName: "claude",
      config: {
        exitCodes: [],
        stderrPatterns: [/429/],
      },
    });

    const result = await runner.run(stubInput);

    assert.equal(result.kind, "rate_limited");
  });

  test("returns the failed result unchanged when nothing matches", async () => {
    const runner = new RateLimitDetectingAgentRunner({
      inner: innerWith({
        kind: "failed",
        exitCode: 1,
        stdout: "",
        stderr: "ordinary failure",
      }),
      agentName: "claude",
      config: { exitCodes: [137], stderrPatterns: [/429/] },
    });

    const result = await runner.run(stubInput);

    assert.equal(result.kind, "failed");
  });
});
