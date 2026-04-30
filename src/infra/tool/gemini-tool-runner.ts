import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProcessRunner } from "../../domain/ports/process-runner.js";
import type { ToolRunner } from "../../domain/ports/tool-runner.js";
import type { ToolRunInput, ToolRunResult } from "../../domain/tool.js";
import { buildBaseEnv, classifyResult } from "./_shared.js";

export interface GeminiFs {
  mkdir: (target: string, options: { recursive: true }) => Promise<unknown>;
  writeFile: (target: string, contents: string) => Promise<void>;
  rm: (
    target: string,
    options: { recursive: true; force: true },
  ) => Promise<void>;
}

export interface GeminiToolRunnerOptions {
  command: string;
  processRunner: ProcessRunner;
  fs?: GeminiFs;
}

const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /rate.?limit/i,
  /quota.*exceeded/i,
  /"code":\s*429/,
];

// Built-in tool name mapping. Gemini's `coreTools` allowlist accepts
// names like `ReadFileTool`, `EditTool`, etc. We deliberately don't
// expose disallow at the built-in tool level — write intent is already
// expressed via approval mode (see pickApprovalMode).
const BUILTIN_TO_GEMINI_TOOL: Record<string, string> = {
  read: "ReadFileTool",
  grep: "GrepTool",
  glob: "GlobTool",
  edit: "EditTool",
  write: "WriteFileTool",
};

export class GeminiToolRunner implements ToolRunner {
  private readonly fs: GeminiFs;

  constructor(private readonly options: GeminiToolRunnerOptions) {
    this.fs = options.fs ?? {
      mkdir: (target, opts) => mkdir(target, opts),
      writeFile,
      rm,
    };
  }

  async run(input: ToolRunInput): Promise<ToolRunResult> {
    const policyPath = path.join(input.workspacePath, ".gemini", "policy.toml");
    const wrotePolicy = await this.writePolicyFile(policyPath, input);

    const args = [
      ...(wrotePolicy ? ["--policy", policyPath] : []),
      "--approval-mode",
      pickApprovalMode(input.allowedTools),
      "--skip-trust",
      "--prompt",
      input.prompt,
    ];

    const raw = await this.options.processRunner.run({
      command: this.options.command,
      args,
      cwd: input.workspacePath,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      env: buildBaseEnv(input),
    });

    return classifyResult(raw, "gemini", RATE_LIMIT_PATTERNS);
  }

  async cleanupArtifacts(workspacePath: string): Promise<void> {
    const target = path.join(workspacePath, ".gemini");
    await this.fs.rm(target, { recursive: true, force: true });
  }

  private async writePolicyFile(
    policyPath: string,
    input: ToolRunInput,
  ): Promise<boolean> {
    const blocks: string[] = [];
    let priority = 100;

    for (const item of input.allowedTools ?? []) {
      const block = toPolicyBlock(item, "allow", priority);
      if (block !== null) {
        blocks.push(block);
        priority += 1;
      }
    }
    // Deny rules take a higher priority band so they always outrank an
    // overlapping allow.
    let denyPriority = 500;
    for (const item of input.disallowedTools ?? []) {
      const block = toPolicyBlock(item, "deny", denyPriority);
      if (block !== null) {
        blocks.push(block);
        denyPriority += 1;
      }
    }

    if (blocks.length === 0) return false;

    await this.fs.mkdir(path.dirname(policyPath), { recursive: true });
    await this.fs.writeFile(policyPath, blocks.join("\n\n") + "\n");
    return true;
  }
}

// `--approval-mode plan` is read-only but hangs in headless mode in
// observed gemini-cli versions, so we always run in `yolo` and rely on
// the policy file for actual fences. Future versions that fix headless
// `plan` could let us flip observe-only strategies to plan mode here.
export function pickApprovalMode(
  _allowed: readonly string[] | undefined,
): "yolo" | "auto_edit" | "default" {
  return "yolo";
}

// Translate a portable spec entry into a Gemini policy `[[rule]]` block.
// Built-in capabilities (read/grep/glob/edit/write) → `toolName` rule
// targeting Gemini's built-in tool name. Shell prefixes →
// `run_shell_command` with `commandPrefix`. Anything unknown returns null.
export function toPolicyBlock(
  spec: string,
  decision: "allow" | "deny",
  priority: number,
): string | null {
  if (spec.startsWith("shell:")) {
    const prefix = spec.slice("shell:".length).trim();
    if (prefix.length === 0) return null;
    return [
      "[[rule]]",
      `toolName = "run_shell_command"`,
      `commandPrefix = ${JSON.stringify(prefix)}`,
      `decision = ${JSON.stringify(decision)}`,
      `priority = ${priority}`,
    ].join("\n");
  }

  const builtin = BUILTIN_TO_GEMINI_TOOL[spec];
  if (builtin === undefined) return null;

  return [
    "[[rule]]",
    `toolName = ${JSON.stringify(builtin)}`,
    `decision = ${JSON.stringify(decision)}`,
    `priority = ${priority}`,
  ].join("\n");
}
