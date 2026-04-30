import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  ProcessRunner,
  RunProcessInput,
  RunProcessResult,
} from "../../src/domain/ports/process-runner.js";
import type { TaskRecord } from "../../src/domain/task.js";
import type { ToolRunInput } from "../../src/domain/tool.js";
import {
  CodexToolRunner,
  pickSandbox,
  toPrefixRule,
  type CodexFs,
} from "../../src/infra/tool/codex-tool-runner.js";

const task: TaskRecord = {
  taskId: "task_codex_1",
  repo: { owner: "octo", name: "repo" },
  source: { kind: "issue", number: 42 },
  instructionId: "issue-comment-reply",
  tool: "codex",
  status: "running",
  priority: "normal",
  requestedBy: "test",
  createdAt: "2026-04-30T00:00:00.000Z",
  startedAt: "2026-04-30T00:01:00.000Z",
};

interface FsCall {
  op: "mkdir" | "writeFile" | "rm";
  target: string;
  contents?: string;
}

function makeFs(): { fs: CodexFs; calls: FsCall[] } {
  const calls: FsCall[] = [];
  const fs: CodexFs = {
    mkdir: async (target, _opts) => {
      calls.push({ op: "mkdir", target });
      return undefined;
    },
    writeFile: async (target, contents) => {
      calls.push({ op: "writeFile", target, contents });
    },
    rm: async (target, _opts) => {
      calls.push({ op: "rm", target });
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
        stdout: result?.stdout ?? "",
        stderr: result?.stderr ?? "",
      };
    },
  };
  return { processRunner, calls };
}

describe("pickSandbox", () => {
  test("returns read-only when no write capability is requested", () => {
    assert.equal(pickSandbox(["read", "grep", "shell:gh"]), "read-only");
    assert.equal(pickSandbox([]), "read-only");
    assert.equal(pickSandbox(undefined), "read-only");
  });

  test("returns workspace-write when edit or write is in the allow list", () => {
    assert.equal(pickSandbox(["read", "edit"]), "workspace-write");
    assert.equal(pickSandbox(["write"]), "workspace-write");
  });
});

describe("toPrefixRule", () => {
  test("returns null for built-in capabilities", () => {
    assert.equal(toPrefixRule("read", "allow"), null);
    assert.equal(toPrefixRule("edit", "forbidden"), null);
  });

  test("emits a Starlark prefix_rule for shell prefixes", () => {
    assert.equal(
      toPrefixRule("shell:gh", "allow"),
      'prefix_rule(\n  pattern = ["gh"],\n  decision = "allow",\n)',
    );
  });

  test("splits multi-token shell prefixes into separate pattern elements", () => {
    assert.equal(
      toPrefixRule("shell:gh pr merge", "forbidden"),
      'prefix_rule(\n  pattern = ["gh", "pr", "merge"],\n  decision = "forbidden",\n)',
    );
  });

  test("returns null for empty shell prefix", () => {
    assert.equal(toPrefixRule("shell:", "allow"), null);
    assert.equal(toPrefixRule("shell:   ", "allow"), null);
  });
});

describe("CodexToolRunner.run", () => {
  test("invokes codex exec with sandbox + ephemeral + skip-git-repo-check + workspace cd + prompt", async () => {
    const { fs } = makeFs();
    const { processRunner, calls } = makeProcessRunner();
    const runner = new CodexToolRunner({
      command: "codex",
      processRunner,
      fs,
    });

    const input: ToolRunInput = {
      task,
      workspacePath: "/tmp/ws",
      prompt: "do the thing",
      allowedTools: ["read", "edit", "shell:gh"],
    };

    await runner.run(input);

    assert.deepEqual(calls[0]?.args, [
      "exec",
      "--sandbox",
      "workspace-write",
      "--ephemeral",
      "--skip-git-repo-check",
      "-C",
      "/tmp/ws",
      "--",
      "do the thing",
    ]);
    assert.equal(calls[0]?.cwd, "/tmp/ws");
  });

  test("picks read-only sandbox when no write capability is allowed", async () => {
    const { fs } = makeFs();
    const { processRunner, calls } = makeProcessRunner();
    const runner = new CodexToolRunner({ command: "codex", processRunner, fs });

    await runner.run({
      task,
      workspacePath: "/tmp/ws",
      prompt: "observe only",
      allowedTools: ["read", "grep", "shell:gh"],
    });

    const sandboxFlagIdx = calls[0]?.args?.indexOf("--sandbox");
    assert.notEqual(sandboxFlagIdx, undefined);
    assert.equal(calls[0]?.args?.[sandboxFlagIdx! + 1], "read-only");
  });

  test("writes a default.rules file with allow + forbidden prefix rules", async () => {
    const { fs, calls: fsCalls } = makeFs();
    const { processRunner } = makeProcessRunner();
    const runner = new CodexToolRunner({ command: "codex", processRunner, fs });

    await runner.run({
      task,
      workspacePath: "/tmp/ws",
      prompt: "x",
      allowedTools: ["read", "shell:gh", "shell:git log"],
      disallowedTools: ["shell:gh pr merge"],
    });

    const mkdirCall = fsCalls.find((c) => c.op === "mkdir");
    const writeCall = fsCalls.find((c) => c.op === "writeFile");

    assert.equal(mkdirCall?.target, "/tmp/ws/.codex/rules");
    assert.equal(writeCall?.target, "/tmp/ws/.codex/rules/default.rules");
    assert.match(writeCall?.contents ?? "", /pattern = \["gh"\][^]*decision = "allow"/);
    assert.match(
      writeCall?.contents ?? "",
      /pattern = \["git", "log"\][^]*decision = "allow"/,
    );
    assert.match(
      writeCall?.contents ?? "",
      /pattern = \["gh", "pr", "merge"\][^]*decision = "forbidden"/,
    );
  });

  test("skips writing rules when neither list contains shell entries", async () => {
    const { fs, calls: fsCalls } = makeFs();
    const { processRunner } = makeProcessRunner();
    const runner = new CodexToolRunner({ command: "codex", processRunner, fs });

    await runner.run({
      task,
      workspacePath: "/tmp/ws",
      prompt: "x",
      allowedTools: ["read", "edit"],
    });

    assert.equal(fsCalls.filter((c) => c.op === "writeFile").length, 0);
    assert.equal(fsCalls.filter((c) => c.op === "mkdir").length, 0);
  });

  test("forwards GH_TOKEN/GITHUB_TOKEN, timeoutMs, and signal", async () => {
    const { fs } = makeFs();
    const { processRunner, calls } = makeProcessRunner();
    const runner = new CodexToolRunner({ command: "codex", processRunner, fs });
    const ac = new AbortController();

    await runner.run({
      task,
      workspacePath: "/tmp/ws",
      prompt: "x",
      installationToken: "ghs_TOKEN",
      timeoutMs: 9000,
      signal: ac.signal,
    });

    assert.equal(calls[0]?.env?.GH_TOKEN, "ghs_TOKEN");
    assert.equal(calls[0]?.env?.GITHUB_TOKEN, "ghs_TOKEN");
    assert.equal(calls[0]?.timeoutMs, 9000);
    assert.equal(calls[0]?.signal, ac.signal);
  });

  test("returns succeeded on exit 0", async () => {
    const { fs } = makeFs();
    const { processRunner } = makeProcessRunner({ exitCode: 0, stdout: "ok" });
    const runner = new CodexToolRunner({ command: "codex", processRunner, fs });

    const result = await runner.run({
      task,
      workspacePath: "/tmp/ws",
      prompt: "x",
    });

    assert.equal(result.kind, "succeeded");
  });

  test("detects rate-limit phrases on a non-zero exit", async () => {
    const { fs } = makeFs();
    const { processRunner } = makeProcessRunner({
      exitCode: 1,
      stdout: "",
      stderr: "rate-limit reached, retry later",
    });
    const runner = new CodexToolRunner({ command: "codex", processRunner, fs });

    const result = await runner.run({
      task,
      workspacePath: "/tmp/ws",
      prompt: "x",
    });

    assert.equal(result.kind, "rate_limited");
    if (result.kind !== "rate_limited") return;
    assert.equal(result.toolName, "codex");
  });
});

describe("CodexToolRunner.cleanupArtifacts", () => {
  test("removes the .codex directory under the workspace", async () => {
    const { fs, calls } = makeFs();
    const runner = new CodexToolRunner({
      command: "codex",
      processRunner: makeProcessRunner().processRunner,
      fs,
    });

    await runner.cleanupArtifacts("/tmp/ws");

    assert.deepEqual(
      calls.filter((c) => c.op === "rm"),
      [{ op: "rm", target: "/tmp/ws/.codex" }],
    );
  });
});
