import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentRunInput, AgentRunResult } from "../../src/domain/agent.js";
import type { InstructionDefinition } from "../../src/domain/instruction.js";
import type { TaskRecord } from "../../src/domain/task.js";
import type { AgentRunner } from "../../src/infra/agent/agent-runner.js";
import {
  RateLimitDetectingAgentRunner,
  RateLimitedError,
} from "../../src/infra/agent/rate-limit-detecting-agent-runner.js";

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
  test("passes the inner result through when nothing matches", async () => {
    const runner = new RateLimitDetectingAgentRunner({
      inner: innerWith({ exitCode: 0, stdout: "ok", stderr: "" }),
      agentName: "claude",
      config: { exitCodes: [], stderrPatterns: [] },
    });

    const result = await runner.run(stubInput);

    assert.equal(result.exitCode, 0);
  });

  test("throws RateLimitedError when the exit code matches", async () => {
    const runner = new RateLimitDetectingAgentRunner({
      inner: innerWith({ exitCode: 137, stdout: "", stderr: "killed" }),
      agentName: "claude",
      config: { exitCodes: [137], stderrPatterns: [] },
    });

    await assert.rejects(runner.run(stubInput), (error) => {
      assert.ok(error instanceof RateLimitedError);
      assert.equal(error.agentName, "claude");
      return true;
    });
  });

  test("throws RateLimitedError when a stderr pattern matches", async () => {
    const runner = new RateLimitDetectingAgentRunner({
      inner: innerWith({
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

    await assert.rejects(runner.run(stubInput), RateLimitedError);
  });

  test("matches patterns against stdout as well as stderr", async () => {
    const runner = new RateLimitDetectingAgentRunner({
      inner: innerWith({
        exitCode: 0,
        stdout: "rate limit reached, retry later",
        stderr: "",
      }),
      agentName: "claude",
      config: {
        exitCodes: [],
        stderrPatterns: [/rate limit/i],
      },
    });

    await assert.rejects(runner.run(stubInput), RateLimitedError);
  });
});
