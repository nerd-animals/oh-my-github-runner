import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentRunInput } from "../../src/domain/agent.js";
import type { TaskRecord } from "../../src/domain/task.js";
import { HeadlessCommandAgentRunner } from "../../src/infra/agent/headless-command-agent-runner.js";
import type {
  ProcessRunner,
  RunProcessInput,
  RunProcessResult,
} from "../../src/domain/ports/process-runner.js";

const task: TaskRecord = {
  taskId: "task_1",
  repo: { owner: "octo", name: "repo" },
  source: { kind: "issue", number: 100 },
  instructionId: "issue-comment-reply",
  tool: "claude",
  status: "running",
  priority: "normal",
  requestedBy: "test",
  createdAt: "2026-04-27T00:00:00.000Z",
  startedAt: "2026-04-27T00:01:00.000Z",
};

function createRunner(): {
  processRunner: ProcessRunner;
  calls: RunProcessInput[];
} {
  const calls: RunProcessInput[] = [];
  const processRunner: ProcessRunner = {
    run: async (input): Promise<RunProcessResult> => {
      calls.push(input);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
  };
  return { processRunner, calls };
}

describe("HeadlessCommandAgentRunner", () => {
  test("forwards GH_TOKEN/GITHUB_TOKEN when an installation token is provided", async () => {
    const { processRunner, calls } = createRunner();
    const runner = new HeadlessCommandAgentRunner({
      command: "claude",
      processRunner,
    });

    const runInput: AgentRunInput = {
      task,
      workspacePath: "/tmp/ws",
      prompt: "hello",
      installationToken: "ghs_FAKE_TOKEN",
    };

    await runner.run(runInput);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.env?.GH_TOKEN, "ghs_FAKE_TOKEN");
    assert.equal(calls[0]?.env?.GITHUB_TOKEN, "ghs_FAKE_TOKEN");
  });

  test("appends --allowed-tools and --disallowed-tools to base args", async () => {
    const { processRunner, calls } = createRunner();
    const runner = new HeadlessCommandAgentRunner({
      command: "claude",
      args: ["--print"],
      processRunner,
    });

    await runner.run({
      task,
      workspacePath: "/tmp/ws",
      prompt: "hello",
      allowedTools: ["Read", "Grep"],
      disallowedTools: ["Edit", "Write"],
    });

    assert.deepEqual(calls[0]?.args, [
      "--print",
      "--allowed-tools",
      "Read Grep",
      "--disallowed-tools",
      "Edit Write",
    ]);
  });

  test("omits tool flags when neither allowed nor disallowed lists are provided", async () => {
    const { processRunner, calls } = createRunner();
    const runner = new HeadlessCommandAgentRunner({
      command: "claude",
      args: ["--print"],
      processRunner,
    });

    await runner.run({ task, workspacePath: "/tmp/ws", prompt: "hello" });

    assert.deepEqual(calls[0]?.args, ["--print"]);
  });

  test("forwards timeoutMs to the process runner", async () => {
    const { processRunner, calls } = createRunner();
    const runner = new HeadlessCommandAgentRunner({
      command: "claude",
      processRunner,
    });

    await runner.run({
      task,
      workspacePath: "/tmp/ws",
      prompt: "hello",
      timeoutMs: 5000,
    });

    assert.equal(calls[0]?.timeoutMs, 5000);
  });

  test("does not set GH_TOKEN/GITHUB_TOKEN when no installation token is provided", async () => {
    const { processRunner, calls } = createRunner();
    const previousGh = process.env.GH_TOKEN;
    const previousGithub = process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;

    try {
      const runner = new HeadlessCommandAgentRunner({
        command: "claude",
        processRunner,
      });

      await runner.run({ task, workspacePath: "/tmp/ws", prompt: "hello" });

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.env?.GH_TOKEN, undefined);
      assert.equal(calls[0]?.env?.GITHUB_TOKEN, undefined);
    } finally {
      if (previousGh !== undefined) process.env.GH_TOKEN = previousGh;
      if (previousGithub !== undefined) process.env.GITHUB_TOKEN = previousGithub;
    }
  });
});
