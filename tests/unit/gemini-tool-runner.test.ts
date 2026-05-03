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
  GeminiToolRunner,
  toPolicyBlock,
  type GeminiFs,
} from "../../src/infra/tool/gemini-tool-runner.js";

const task: TaskRecord = {
  taskId: "task_gemini_1",
  repo: { owner: "octo", name: "repo" },
  source: { kind: "issue", number: 7 },
  instructionId: "issue-comment-reply",
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

function makeFs(): { fs: GeminiFs; calls: FsCall[] } {
  const calls: FsCall[] = [];
  const fs: GeminiFs = {
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

describe("toPolicyBlock", () => {
  test("emits a run_shell_command rule with commandPrefix for shell entries", () => {
    const block = toPolicyBlock("shell:gh", "allow", 100);
    assert.match(block ?? "", /\[\[rule\]\]/);
    assert.match(block ?? "", /toolName = "run_shell_command"/);
    assert.match(block ?? "", /commandPrefix = "gh"/);
    assert.match(block ?? "", /decision = "allow"/);
    assert.match(block ?? "", /priority = 100/);
  });

  test("preserves multi-token shell prefixes verbatim", () => {
    const block = toPolicyBlock("shell:gh pr merge", "deny", 500);
    assert.match(block ?? "", /commandPrefix = "gh pr merge"/);
    assert.match(block ?? "", /decision = "deny"/);
  });

  test("maps built-in capabilities to Gemini tool names", () => {
    assert.match(
      toPolicyBlock("read", "allow", 100) ?? "",
      /toolName = "ReadFileTool"/,
    );
    assert.match(
      toPolicyBlock("edit", "allow", 100) ?? "",
      /toolName = "EditTool"/,
    );
    assert.match(
      toPolicyBlock("write", "allow", 100) ?? "",
      /toolName = "WriteFileTool"/,
    );
    assert.match(
      toPolicyBlock("grep", "allow", 100) ?? "",
      /toolName = "GrepTool"/,
    );
    assert.match(
      toPolicyBlock("glob", "allow", 100) ?? "",
      /toolName = "GlobTool"/,
    );
  });

  test("returns null for empty shell prefix or unknown vocab", () => {
    assert.equal(toPolicyBlock("shell:", "allow", 100), null);
    assert.equal(toPolicyBlock("shell:   ", "allow", 100), null);
    assert.equal(toPolicyBlock("not-a-real-cap", "allow", 100), null);
  });
});

describe("GeminiToolRunner.run", () => {
  test("invokes gemini with --policy, --approval-mode yolo, --skip-trust, and --prompt", async () => {
    const { fs } = makeFs();
    const { processRunner, calls } = makeProcessRunner();
    const runner = new GeminiToolRunner({
      command: "gemini",
      processRunner,
      fs,
    });

    const input: ToolRunInput = {
      task,
      workspacePath: "/tmp/ws",
      prompt: "do work",
      allowedTools: ["read", "shell:gh"],
    };

    await runner.run(input);

    assert.deepEqual(calls[0]?.args, [
      "--policy",
      "/tmp/ws/.gemini/policy.toml",
      "--approval-mode",
      "yolo",
      "--skip-trust",
      "--prompt",
      "do work",
    ]);
    assert.equal(calls[0]?.cwd, "/tmp/ws");
  });

  test("omits --policy when there is nothing to express", async () => {
    const { fs, calls: fsCalls } = makeFs();
    const { processRunner, calls } = makeProcessRunner();
    const runner = new GeminiToolRunner({ command: "gemini", processRunner, fs });

    await runner.run({ task, workspacePath: "/tmp/ws", prompt: "hi" });

    assert.equal(fsCalls.filter((c) => c.op === "writeFile").length, 0);
    assert.equal(calls[0]?.args?.includes("--policy"), false);
  });

  test("writes policy.toml under workspace's .gemini/", async () => {
    const { fs, calls: fsCalls } = makeFs();
    const { processRunner } = makeProcessRunner();
    const runner = new GeminiToolRunner({ command: "gemini", processRunner, fs });

    await runner.run({
      task,
      workspacePath: "/tmp/ws",
      prompt: "x",
      allowedTools: ["read", "shell:gh", "shell:git log"],
      disallowedTools: ["shell:gh pr merge"],
    });

    const mkdirCall = fsCalls.find((c) => c.op === "mkdir");
    const writeCall = fsCalls.find((c) => c.op === "writeFile");

    assert.equal(mkdirCall?.target, "/tmp/ws/.gemini");
    assert.equal(writeCall?.target, "/tmp/ws/.gemini/policy.toml");

    const contents = writeCall?.contents ?? "";
    // Allow rules
    assert.match(contents, /toolName = "ReadFileTool"[^]*decision = "allow"/);
    assert.match(contents, /commandPrefix = "gh"[^]*decision = "allow"/);
    assert.match(contents, /commandPrefix = "git log"[^]*decision = "allow"/);
    // Deny outranks allow via priority band
    assert.match(
      contents,
      /commandPrefix = "gh pr merge"[^]*decision = "deny"[^]*priority = 5\d\d/,
    );
  });

  test("forwards GH_TOKEN/GITHUB_TOKEN, timeoutMs, and signal", async () => {
    const { fs } = makeFs();
    const { processRunner, calls } = makeProcessRunner();
    const runner = new GeminiToolRunner({ command: "gemini", processRunner, fs });
    const ac = new AbortController();

    await runner.run({
      task,
      workspacePath: "/tmp/ws",
      prompt: "x",
      installationToken: "ghs_FAKE",
      timeoutMs: 7000,
      signal: ac.signal,
    });

    assert.equal(calls[0]?.env?.GH_TOKEN, "ghs_FAKE");
    assert.equal(calls[0]?.env?.GITHUB_TOKEN, "ghs_FAKE");
    assert.equal(calls[0]?.timeoutMs, 7000);
    assert.equal(calls[0]?.signal, ac.signal);
  });

  test("returns succeeded on exit 0", async () => {
    const { fs } = makeFs();
    const { processRunner } = makeProcessRunner({ exitCode: 0, stdout: "ok" });
    const runner = new GeminiToolRunner({ command: "gemini", processRunner, fs });

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
      stderr: 'API quota exceeded for project',
    });
    const runner = new GeminiToolRunner({ command: "gemini", processRunner, fs });

    const result = await runner.run({
      task,
      workspacePath: "/tmp/ws",
      prompt: "x",
    });

    assert.equal(result.kind, "rate_limited");
    if (result.kind !== "rate_limited") return;
    assert.equal(result.toolName, "gemini");
  });
});

describe("GeminiToolRunner.cleanupArtifacts", () => {
  test("removes the .gemini directory under the workspace", async () => {
    const { fs, calls } = makeFs();
    const runner = new GeminiToolRunner({
      command: "gemini",
      processRunner: makeProcessRunner().processRunner,
      fs,
    });

    await runner.cleanupArtifacts("/tmp/ws");

    assert.deepEqual(
      calls.filter((c) => c.op === "rm"),
      [{ op: "rm", target: "/tmp/ws/.gemini" }],
    );
  });
});
