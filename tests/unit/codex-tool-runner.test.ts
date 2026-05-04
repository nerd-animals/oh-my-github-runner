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
  CodexToolRunner,
  toPrefixRule,
  type CodexFs,
} from "../../src/infra/tool/codex-tool-runner.js";

const task: TaskRecord = {
  taskId: "task_codex_1",
  repo: { owner: "octo", name: "repo" },
  source: { kind: "issue", number: 42 },
  instructionId: "issue-comment-reply",
  status: "running",
  priority: "normal",
  requestedBy: "test",
  createdAt: "2026-04-30T00:00:00.000Z",
  startedAt: "2026-04-30T00:01:00.000Z",
};

interface FsCall {
  op: "mkdir" | "writeFile" | "readFile" | "rm";
  target: string;
  contents?: string;
}

function makeFs(
  options: { readFiles?: Record<string, string>; readFileMissing?: boolean } = {},
): { fs: CodexFs; calls: FsCall[] } {
  const calls: FsCall[] = [];
  const fs: CodexFs = {
    mkdir: async (target, _opts) => {
      calls.push({ op: "mkdir", target });
      return undefined;
    },
    writeFile: async (target, contents) => {
      calls.push({ op: "writeFile", target, contents });
    },
    readFile: async (target) => {
      calls.push({ op: "readFile", target });
      if (options.readFileMissing === true) {
        const err = new Error(`ENOENT: ${target}`);
        (err as NodeJS.ErrnoException).code = "ENOENT";
        throw err;
      }
      const stub = options.readFiles?.[target];
      if (stub !== undefined) {
        return stub;
      }
      return "";
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
  test("invokes codex exec with sandbox + ephemeral + skip-git-repo-check + workspace cd, passing prompt via stdin", async () => {
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
      "-",
    ]);
    assert.equal(calls[0]?.cwd, "/tmp/ws");
    assert.equal(calls[0]?.stdin, "do the thing");
    assert.equal(calls[0]?.args?.includes("do the thing"), false);
  });

  test("passes a multi-MiB prompt via stdin without writing it to argv (ARG_MAX guard)", async () => {
    const { fs } = makeFs();
    const { processRunner, calls } = makeProcessRunner();
    const runner = new CodexToolRunner({ command: "codex", processRunner, fs });

    // 3 MiB exceeds the typical Linux ARG_MAX (~2 MiB) and would crash
    // spawn() with E2BIG if the prompt were placed on argv.
    const prompt = "x".repeat(3 * 1024 * 1024);

    await runner.run({
      task,
      workspacePath: "/tmp/ws",
      prompt,
    });

    assert.equal(calls[0]?.stdin, prompt);
    assert.equal(calls[0]?.args?.includes(prompt), false);
  });

  test("writes a default.rules file with allow + forbidden prefix rules", async () => {
    const { fs, calls: fsCalls } = makeFs();
    const { processRunner } = makeProcessRunner();
    const runner = new CodexToolRunner({ command: "codex", processRunner, fs });
    const rulesDir = path.join("/tmp/ws", ".codex", "rules");

    await runner.run({
      task,
      workspacePath: "/tmp/ws",
      prompt: "x",
      allowedTools: ["read", "shell:gh", "shell:git log"],
      disallowedTools: ["shell:gh pr merge"],
    });

    const mkdirCall = fsCalls.find((c) => c.op === "mkdir");
    const writeCall = fsCalls.find((c) => c.op === "writeFile");

    assert.equal(mkdirCall?.target, rulesDir);
    assert.equal(writeCall?.target, path.join(rulesDir, "default.rules"));
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

  test("with outputSchema: writes schema file, passes --output-schema and -o, returns last-message contents as stdout", async () => {
    const lastMessageBody = '{"decision_type":"no_action","reasoning":"ack only"}';
    const codexDir = path.join("/tmp/ws", ".codex");
    const schemaFile = path.join(codexDir, "output.schema.json");
    const lastMsgFile = path.join(codexDir, "last-message.txt");
    const { fs, calls: fsCalls } = makeFs({
      readFiles: { [lastMsgFile]: lastMessageBody },
    });
    const { processRunner, calls: procCalls } = makeProcessRunner({
      exitCode: 0,
      stdout: "raw stdout (should be replaced)",
    });
    const runner = new CodexToolRunner({ command: "codex", processRunner, fs });
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["decision_type"],
      properties: { decision_type: { type: "string" } },
    } as const;

    const result = await runner.run({
      task,
      workspacePath: "/tmp/ws",
      prompt: "decide",
      outputSchema: schema,
    });

    // mkdir for .codex + writeFile for the schema file
    const mkdirTargets = fsCalls.filter((c) => c.op === "mkdir").map((c) => c.target);
    const writeTargets = fsCalls.filter((c) => c.op === "writeFile");
    assert.ok(mkdirTargets.includes(codexDir));
    const schemaWrite = writeTargets.find((c) => c.target === schemaFile);
    assert.ok(schemaWrite, "schema file must be written");
    assert.deepEqual(JSON.parse(schemaWrite!.contents ?? ""), schema);

    // CLI args include --output-schema <path> and -o <last-message>
    const args = procCalls[0]?.args ?? [];
    const schemaIdx = args.indexOf("--output-schema");
    assert.ok(schemaIdx >= 0, "--output-schema must be passed");
    assert.equal(args[schemaIdx + 1], schemaFile);
    const oIdx = args.indexOf("-o");
    assert.ok(oIdx >= 0, "-o must be passed");
    assert.equal(args[oIdx + 1], lastMsgFile);

    // -- separator and stdin sentinel remain at the tail; prompt body goes via stdin
    assert.equal(args[args.length - 2], "--");
    assert.equal(args[args.length - 1], "-");
    assert.equal(procCalls[0]?.stdin, "decide");

    // stdout should be the last-message file contents, not the raw stdout
    assert.equal(result.kind, "succeeded");
    if (result.kind === "succeeded") {
      assert.equal(result.stdout, lastMessageBody);
    }
  });

  test("with outputSchema: falls back to raw stdout when last-message file is missing", async () => {
    const { fs } = makeFs({ readFileMissing: true });
    const { processRunner } = makeProcessRunner({ exitCode: 0, stdout: "fallback" });
    const runner = new CodexToolRunner({ command: "codex", processRunner, fs });

    const result = await runner.run({
      task,
      workspacePath: "/tmp/ws",
      prompt: "x",
      outputSchema: { type: "object" },
    });

    assert.equal(result.kind, "succeeded");
    if (result.kind === "succeeded") {
      assert.equal(result.stdout, "fallback");
    }
  });

  test("with outputSchema: returns failed when last-message file is empty", async () => {
    const codexDir = path.join("/tmp/ws", ".codex");
    const lastMsgFile = path.join(codexDir, "last-message.txt");
    const { fs } = makeFs({ readFiles: { [lastMsgFile]: "   \n" } });
    const { processRunner } = makeProcessRunner({
      exitCode: 0,
      stdout: "codex verbose log",
      stderr: "",
    });
    const runner = new CodexToolRunner({ command: "codex", processRunner, fs });

    const result = await runner.run({
      task,
      workspacePath: "/tmp/ws",
      prompt: "x",
      outputSchema: { type: "object" },
    });

    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "codex verbose log");
    assert.match(result.stderr, /empty last-message\.txt/);
  });

  test("without outputSchema: schema file is not written and --output-schema is absent", async () => {
    const { fs, calls: fsCalls } = makeFs();
    const { processRunner, calls: procCalls } = makeProcessRunner();
    const runner = new CodexToolRunner({ command: "codex", processRunner, fs });

    await runner.run({ task, workspacePath: "/tmp/ws", prompt: "x" });

    const writes = fsCalls.filter(
      (c) => c.op === "writeFile" && c.target.endsWith("output.schema.json"),
    );
    assert.equal(writes.length, 0);
    const args = procCalls[0]?.args ?? [];
    assert.ok(!args.includes("--output-schema"));
    assert.ok(!args.includes("-o"));
  });

  // Real codex CLI samples. The first is the production stderr from #107;
  // the rest are upstream/HTTP-level signals the runner may surface either
  // directly or via wrapped error envelopes.
  const RATE_LIMIT_POSITIVES: ReadonlyArray<{ name: string; stderr: string }> = [
    {
      name: "codex usage-limit message (#107)",
      stderr:
        "ERROR: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 2:25 AM.",
    },
    { name: "HTTP 429 status line", stderr: "Error: HTTP 429 Too Many Requests" },
    { name: "JSON status:429 envelope", stderr: '{"error":{"status": 429}}' },
    { name: "Retry-After header", stderr: "Retry-After: 60" },
    { name: "RATE_LIMIT_EXCEEDED code", stderr: "code=RATE_LIMIT_EXCEEDED" },
    { name: "quota exceeded phrase", stderr: "quota exceeded for this minute" },
  ];

  for (const { name, stderr } of RATE_LIMIT_POSITIVES) {
    test(`classifies as rate_limited: ${name}`, async () => {
      const { fs } = makeFs();
      const { processRunner } = makeProcessRunner({ exitCode: 1, stdout: "", stderr });
      const runner = new CodexToolRunner({ command: "codex", processRunner, fs });

      const result = await runner.run({ task, workspacePath: "/tmp/ws", prompt: "x" });

      assert.equal(result.kind, "rate_limited", `expected rate_limited for: ${stderr}`);
      if (result.kind !== "rate_limited") return;
      assert.equal(result.toolName, "codex");
    });
  }

  // Substrings that the previous bare `/rate.?limit/i` pattern matched as
  // false positives: file-path components, test fixture names, debug logs,
  // and user comments echoed back into stdout/stderr.
  const RATE_LIMIT_NEGATIVES: ReadonlyArray<{ name: string; stderr: string }> = [
    { name: "hyphenated path component", stderr: "Error reading rate-limit-exempt path" },
    { name: "test fixture name", stderr: "FAIL: rate limited test fixture" },
    { name: "debug log line", stderr: "WARN: rate-limited path detected" },
    {
      name: "user comment echo",
      stderr: 'User said: "please respect the rate limit when calling the API"',
    },
  ];

  for (const { name, stderr } of RATE_LIMIT_NEGATIVES) {
    test(`classifies as failed (false-positive guard): ${name}`, async () => {
      const { fs } = makeFs();
      const { processRunner } = makeProcessRunner({ exitCode: 1, stdout: "", stderr });
      const runner = new CodexToolRunner({ command: "codex", processRunner, fs });

      const result = await runner.run({ task, workspacePath: "/tmp/ws", prompt: "x" });

      assert.equal(result.kind, "failed", `expected failed for: ${stderr}`);
    });
  }

  test("exit 0 stays succeeded even when output contains rate-limit phrases", async () => {
    // _shared.classifyResult short-circuits on exit 0; pin that invariant
    // so a future refactor cannot accidentally promote a successful run
    // to rate_limited just because the model echoed the phrase.
    const { fs } = makeFs();
    const { processRunner } = makeProcessRunner({
      exitCode: 0,
      stdout: "You've hit your usage limit",
      stderr: "HTTP 429",
    });
    const runner = new CodexToolRunner({ command: "codex", processRunner, fs });

    const result = await runner.run({ task, workspacePath: "/tmp/ws", prompt: "x" });

    assert.equal(result.kind, "succeeded");
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
      [{ op: "rm", target: path.join("/tmp/ws", ".codex") }],
    );
  });
});
