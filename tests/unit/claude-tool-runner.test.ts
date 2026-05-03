import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import type {
  ProcessRunner,
  RunProcessInput,
  RunProcessResult,
} from "../../src/domain/ports/process-runner.js";
import type { TaskRecord } from "../../src/domain/task.js";
import type { ToolRunInput } from "../../src/domain/tool.js";
import {
  ClaudeToolRunner,
  encodeProjectsDirName,
  type ClaudeProjectsFs,
} from "../../src/infra/tool/claude-tool-runner.js";

const task: TaskRecord = {
  taskId: "task_1",
  repo: { owner: "octo", name: "repo" },
  source: { kind: "issue", number: 100 },
  instructionId: "issue-comment-reply",
  status: "running",
  priority: "normal",
  requestedBy: "test",
  createdAt: "2026-04-27T00:00:00.000Z",
  startedAt: "2026-04-27T00:01:00.000Z",
};

interface FsCall {
  op: "rm" | "stat";
  target: string;
}

function makeFs(options: { statThrows?: boolean } = {}): {
  fs: ClaudeProjectsFs;
  calls: FsCall[];
} {
  const calls: FsCall[] = [];
  const fs: ClaudeProjectsFs = {
    rm: async (target, _opts) => {
      calls.push({ op: "rm", target });
    },
    stat: async (target) => {
      calls.push({ op: "stat", target });
      if (options.statThrows === true) {
        throw new Error("ENOENT");
      }
      return {};
    },
  };
  return { fs, calls };
}

function makeProcessRunner(result?: Partial<RunProcessResult>): {
  processRunner: ProcessRunner;
  calls: RunProcessInput[];
} {
  const calls: RunProcessInput[] = [];
  const processRunner: ProcessRunner = {
    run: async (input): Promise<RunProcessResult> => {
      calls.push(input);
      return {
        exitCode: result?.exitCode ?? 0,
        stdout: result?.stdout ?? "ok",
        stderr: result?.stderr ?? "",
      };
    },
  };
  return { processRunner, calls };
}

const baseRunnerOptions = {
  command: "claude",
  workspacesDir: "/srv/workspaces",
  claudeHome: "/var/cache/claude",
};

describe("ClaudeToolRunner.run", () => {
  test("translates portable vocabulary into Claude tool names", async () => {
    const { processRunner, calls } = makeProcessRunner();
    const runner = new ClaudeToolRunner({ ...baseRunnerOptions, processRunner });

    const input: ToolRunInput = {
      task,
      workspacePath: "/tmp/ws",
      prompt: "hello",
      allowedTools: ["read", "grep", "edit", "shell:gh", "shell:git log"],
      disallowedTools: ["shell:gh pr merge"],
    };
    await runner.run(input);

    const args = calls[0]?.args;
    assert.deepEqual(args, [
      "-p",
      "--allowed-tools",
      "Read Grep Edit MultiEdit Bash(gh:*) Bash(git log:*)",
      "--disallowed-tools",
      "Bash(gh pr merge:*)",
    ]);
  });

  test("passes prompt through stdin and forwards timeoutMs", async () => {
    const { processRunner, calls } = makeProcessRunner();
    const runner = new ClaudeToolRunner({ ...baseRunnerOptions, processRunner });

    await runner.run({
      task,
      workspacePath: "/tmp/ws",
      prompt: "hello",
      timeoutMs: 5000,
    });

    assert.equal(calls[0]?.stdin, "hello");
    assert.equal(calls[0]?.cwd, "/tmp/ws");
    assert.equal(calls[0]?.timeoutMs, 5000);
  });

  test("forwards GH_TOKEN and GITHUB_TOKEN when an installation token is provided", async () => {
    const { processRunner, calls } = makeProcessRunner();
    const runner = new ClaudeToolRunner({ ...baseRunnerOptions, processRunner });

    await runner.run({
      task,
      workspacePath: "/tmp/ws",
      prompt: "hello",
      installationToken: "ghs_FAKE_TOKEN",
    });

    assert.equal(calls[0]?.env?.GH_TOKEN, "ghs_FAKE_TOKEN");
    assert.equal(calls[0]?.env?.GITHUB_TOKEN, "ghs_FAKE_TOKEN");
  });

  test("does not set GH_TOKEN/GITHUB_TOKEN when no installation token is provided", async () => {
    const previousGh = process.env.GH_TOKEN;
    const previousGithub = process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;

    try {
      const { processRunner, calls } = makeProcessRunner();
      const runner = new ClaudeToolRunner({ ...baseRunnerOptions, processRunner });

      await runner.run({ task, workspacePath: "/tmp/ws", prompt: "hello" });

      assert.equal(calls[0]?.env?.GH_TOKEN, undefined);
      assert.equal(calls[0]?.env?.GITHUB_TOKEN, undefined);
    } finally {
      if (previousGh !== undefined) process.env.GH_TOKEN = previousGh;
      if (previousGithub !== undefined) process.env.GITHUB_TOKEN = previousGithub;
    }
  });

  test("omits permission flags when neither list is provided", async () => {
    const { processRunner, calls } = makeProcessRunner();
    const runner = new ClaudeToolRunner({ ...baseRunnerOptions, processRunner });

    await runner.run({ task, workspacePath: "/tmp/ws", prompt: "hi" });

    assert.deepEqual(calls[0]?.args, ["-p"]);
  });

  test("throws when outputSchema is provided (claude runner does not yet support structured output)", async () => {
    const { processRunner, calls } = makeProcessRunner();
    const runner = new ClaudeToolRunner({ ...baseRunnerOptions, processRunner });

    await assert.rejects(
      runner.run({
        task,
        workspacePath: "/tmp/ws",
        prompt: "hi",
        outputSchema: { type: "object" },
      }),
      /outputSchema is not yet supported/,
    );
    // Process must not be invoked when the runner refuses up front.
    assert.equal(calls.length, 0);
  });

  test("returns succeeded on exit 0", async () => {
    const { processRunner } = makeProcessRunner({ exitCode: 0, stdout: "done" });
    const runner = new ClaudeToolRunner({ ...baseRunnerOptions, processRunner });

    const result = await runner.run({
      task,
      workspacePath: "/tmp/ws",
      prompt: "hi",
    });

    assert.equal(result.kind, "succeeded");
    if (result.kind !== "succeeded") return;
    assert.equal(result.stdout, "done");
  });

  test("detects rate-limit phrases in stdout/stderr on a non-zero exit", async () => {
    for (const sample of [
      "You've hit your org's monthly usage limit",
      "You've hit your limit · resets 11:30am (UTC)",
      '"api_error_status": 429,',
    ]) {
      const { processRunner } = makeProcessRunner({
        exitCode: 1,
        stdout: sample,
        stderr: "",
      });
      const runner = new ClaudeToolRunner({ ...baseRunnerOptions, processRunner });

      const result = await runner.run({
        task,
        workspacePath: "/tmp/ws",
        prompt: "hi",
      });

      assert.equal(result.kind, "rate_limited", `expected rate_limited for: ${sample}`);
      if (result.kind !== "rate_limited") continue;
      assert.equal(result.toolName, "claude");
    }
  });

  test("returns failed when no rate-limit pattern matches a non-zero exit", async () => {
    const { processRunner } = makeProcessRunner({
      exitCode: 2,
      stdout: "",
      stderr: "ordinary failure",
    });
    const runner = new ClaudeToolRunner({ ...baseRunnerOptions, processRunner });

    const result = await runner.run({
      task,
      workspacePath: "/tmp/ws",
      prompt: "hi",
    });

    assert.equal(result.kind, "failed");
  });
});

describe("ClaudeToolRunner.cleanupArtifacts", () => {
  test("removes the encoded projects dir for a workspace inside workspacesDir", async () => {
    const { fs, calls } = makeFs();
    const workspacesDir = "/home/ubuntu/runner-deploy/var/workspaces";
    const claudeHome = "/home/ubuntu/.claude";
    const workspacePath =
      "/home/ubuntu/runner-deploy/var/workspaces/task_1777391732491_qc7ixeyy";
    const runner = new ClaudeToolRunner({
      ...baseRunnerOptions,
      processRunner: makeProcessRunner().processRunner,
      workspacesDir,
      claudeHome,
      fs,
    });

    await runner.cleanupArtifacts(workspacePath);

    const target = path.join(
      claudeHome,
      "projects",
      encodeProjectsDirName(path.resolve(workspacePath)),
    );

    assert.deepEqual(calls, [
      {
        op: "stat",
        target,
      },
      {
        op: "rm",
        target,
      },
    ]);
  });

  test("is a no-op (no rm) when the encoded dir does not exist", async () => {
    const { fs, calls } = makeFs({ statThrows: true });
    const runner = new ClaudeToolRunner({
      ...baseRunnerOptions,
      processRunner: makeProcessRunner().processRunner,
      workspacesDir: "/home/ubuntu/runner-deploy/var/workspaces",
      claudeHome: "/home/ubuntu/.claude",
      fs,
    });

    await runner.cleanupArtifacts(
      "/home/ubuntu/runner-deploy/var/workspaces/task_does_not_exist",
    );

    assert.equal(calls.filter((c) => c.op === "rm").length, 0);
    assert.equal(calls.filter((c) => c.op === "stat").length, 1);
  });

  test("refuses paths outside workspacesDir", async () => {
    const { fs, calls } = makeFs();
    const runner = new ClaudeToolRunner({
      ...baseRunnerOptions,
      processRunner: makeProcessRunner().processRunner,
      workspacesDir: "/home/ubuntu/runner-deploy/var/workspaces",
      claudeHome: "/home/ubuntu/.claude",
      fs,
    });

    await runner.cleanupArtifacts("/home/ubuntu");
    await runner.cleanupArtifacts("/etc/passwd");
    await runner.cleanupArtifacts("/home/ubuntu/runner-deploy");
    await runner.cleanupArtifacts(
      "/home/ubuntu/oh-my-github-runner/var/workspaces/task_1",
    );

    assert.deepEqual(calls, []);
  });

  test("refuses the workspacesDir itself", async () => {
    const { fs, calls } = makeFs();
    const runner = new ClaudeToolRunner({
      ...baseRunnerOptions,
      processRunner: makeProcessRunner().processRunner,
      workspacesDir: "/home/ubuntu/runner-deploy/var/workspaces",
      claudeHome: "/home/ubuntu/.claude",
      fs,
    });

    await runner.cleanupArtifacts("/home/ubuntu/runner-deploy/var/workspaces");
    await runner.cleanupArtifacts("/home/ubuntu/runner-deploy/var/workspaces/");

    assert.deepEqual(calls, []);
  });

  test("refuses traversal segments", async () => {
    const { fs, calls } = makeFs();
    const runner = new ClaudeToolRunner({
      ...baseRunnerOptions,
      processRunner: makeProcessRunner().processRunner,
      workspacesDir: "/home/ubuntu/runner-deploy/var/workspaces",
      claudeHome: "/home/ubuntu/.claude",
      fs,
    });

    await runner.cleanupArtifacts(
      "/home/ubuntu/runner-deploy/var/workspaces/task_1/../../../../etc",
    );

    assert.deepEqual(calls, []);
  });

  test("refuses sibling-prefix paths", async () => {
    const { fs, calls } = makeFs();
    const runner = new ClaudeToolRunner({
      ...baseRunnerOptions,
      processRunner: makeProcessRunner().processRunner,
      workspacesDir: "/home/ubuntu/runner-deploy/var/workspaces",
      claudeHome: "/home/ubuntu/.claude",
      fs,
    });

    await runner.cleanupArtifacts(
      "/home/ubuntu/runner-deploy/var/workspaces-evil/task_1",
    );

    assert.deepEqual(calls, []);
  });
});

describe("encodeProjectsDirName", () => {
  test("matches the observed claude CLI encoding for runner workspace paths", () => {
    assert.equal(
      encodeProjectsDirName(
        "/home/ubuntu/runner-deploy/var/workspaces/task_1777391732491_qc7ixeyy",
      ),
      "-home-ubuntu-runner-deploy-var-workspaces-task-1777391732491-qc7ixeyy",
    );
  });

  test("replaces every non-alphanumeric character", () => {
    assert.equal(encodeProjectsDirName("/a.b_c/d-e/f"), "-a-b-c-d-e-f");
  });
});
