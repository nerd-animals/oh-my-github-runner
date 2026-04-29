import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ToolRunInput, ToolRunResult } from "../../src/domain/tool.js";
import type { TaskRecord } from "../../src/domain/task.js";
import type { ToolRunner } from "../../src/domain/ports/tool-runner.js";
import { RateLimitDetectingToolRunner } from "../../src/infra/tool/rate-limit-detecting-tool-runner.js";

const stubInput: ToolRunInput = {
  task: {} as TaskRecord,
  workspacePath: "/tmp",
  prompt: "",
};

function innerWith(result: ToolRunResult): ToolRunner {
  return { run: async () => result };
}

describe("RateLimitDetectingToolRunner", () => {
  test("passes a successful inner result through unchanged", async () => {
    const runner = new RateLimitDetectingToolRunner({
      inner: innerWith({ kind: "succeeded", stdout: "ok" }),
      toolName: "claude",
      config: { exitCodes: [], stderrPatterns: [] },
    });

    const result = await runner.run(stubInput);

    assert.equal(result.kind, "succeeded");
  });

  test("returns a rate_limited result when the exit code matches", async () => {
    const runner = new RateLimitDetectingToolRunner({
      inner: innerWith({
        kind: "failed",
        exitCode: 137,
        stdout: "",
        stderr: "killed",
      }),
      toolName: "claude",
      config: { exitCodes: [137], stderrPatterns: [] },
    });

    const result = await runner.run(stubInput);

    assert.equal(result.kind, "rate_limited");
    if (result.kind !== "rate_limited") return;
    assert.equal(result.toolName, "claude");
    assert.match(result.signal, /exit_code=137/);
  });

  test("returns a rate_limited result when a stderr pattern matches", async () => {
    const runner = new RateLimitDetectingToolRunner({
      inner: innerWith({
        kind: "failed",
        exitCode: 1,
        stdout: "",
        stderr: "Anthropic API: 429 Too Many Requests",
      }),
      toolName: "claude",
      config: {
        exitCodes: [],
        stderrPatterns: [/429/],
      },
    });

    const result = await runner.run(stubInput);

    assert.equal(result.kind, "rate_limited");
  });

  test("returns the failed result unchanged when nothing matches", async () => {
    const runner = new RateLimitDetectingToolRunner({
      inner: innerWith({
        kind: "failed",
        exitCode: 1,
        stdout: "",
        stderr: "ordinary failure",
      }),
      toolName: "claude",
      config: { exitCodes: [137], stderrPatterns: [/429/] },
    });

    const result = await runner.run(stubInput);

    assert.equal(result.kind, "failed");
  });
});
