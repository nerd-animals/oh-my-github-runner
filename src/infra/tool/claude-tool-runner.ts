import { rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ProcessRunner } from "../../domain/ports/process-runner.js";
import type { ToolRunner } from "../../domain/ports/tool-runner.js";
import type { ToolRunInput, ToolRunResult } from "../../domain/tool.js";
import { buildBaseEnv, classifyResult } from "./_shared.js";

export interface ClaudeProjectsFs {
  rm: (
    target: string,
    options: { recursive: true; force: true },
  ) => Promise<void>;
  stat: (target: string) => Promise<unknown>;
}

export interface ClaudeToolRunnerOptions {
  command: string;
  processRunner: ProcessRunner;
  // Workspace root used to scope artifact cleanup. Cleanup refuses any
  // path not nested under this directory, so the runner can never delete
  // an unrelated `~/.claude/projects/*` entry.
  workspacesDir: string;
  // Where Claude Code stores per-project session state. Default
  // installations write to `~/.claude`.
  claudeHome: string;
  fs?: ClaudeProjectsFs;
}

// Claude Code returns exit code 0 even when it has hit a usage cap; the
// failure shows up either in plain stdout (when invoked with -p alone)
// or as the "result" field of the JSON envelope. Both phrasings observed
// in production. JSON-mode "api_error_status":429 is the escape hatch.
const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /You've hit your.*limit/,
  /"api_error_status":\s*429/,
];

export class ClaudeToolRunner implements ToolRunner {
  private readonly fs: ClaudeProjectsFs;

  constructor(private readonly options: ClaudeToolRunnerOptions) {
    this.fs = options.fs ?? { rm, stat };
  }

  async run(input: ToolRunInput): Promise<ToolRunResult> {
    const args = ["-p", ...this.buildPermissionArgs(input)];

    const raw = await this.options.processRunner.run({
      command: this.options.command,
      args,
      cwd: input.workspacePath,
      stdin: input.prompt,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      env: buildBaseEnv(input),
    });

    return classifyResult(raw, "claude", RATE_LIMIT_PATTERNS);
  }

  async cleanupArtifacts(workspacePath: string): Promise<void> {
    const projectsDir = path.join(this.options.claudeHome, "projects");
    const workspacesDir = path.resolve(this.options.workspacesDir);
    const workspacesPrefix = workspacesDir + path.sep;
    const expectedNamePrefix = encodeProjectsDirName(workspacesDir) + "-";
    const resolvedWorkspace = path.resolve(workspacePath);

    if (
      resolvedWorkspace === workspacesDir ||
      !resolvedWorkspace.startsWith(workspacesPrefix)
    ) {
      return;
    }

    const encodedName = encodeProjectsDirName(resolvedWorkspace);
    if (!encodedName.startsWith(expectedNamePrefix)) {
      return;
    }
    if (encodedName.includes(path.sep)) {
      return;
    }

    const target = path.join(projectsDir, encodedName);
    if (path.dirname(target) !== projectsDir) {
      return;
    }

    try {
      await this.fs.stat(target);
    } catch {
      return;
    }

    await this.fs.rm(target, { recursive: true, force: true });
  }

  private buildPermissionArgs(input: ToolRunInput): string[] {
    const args: string[] = [];

    if (input.allowedTools !== undefined && input.allowedTools.length > 0) {
      args.push("--allowed-tools", translateList(input.allowedTools));
    }
    if (
      input.disallowedTools !== undefined &&
      input.disallowedTools.length > 0
    ) {
      args.push("--disallowed-tools", translateList(input.disallowedTools));
    }

    return args;
  }
}

// Mirrors Claude Code's filename encoding: any non-alphanumeric byte
// (including `/`, `.`, `_`, `-`) becomes a single `-`. We use this to
// derive the directory name Claude wrote under `~/.claude/projects/`.
export function encodeProjectsDirName(absolutePath: string): string {
  return absolutePath.replace(/[^a-zA-Z0-9]/g, "-");
}

// Portable vocab → Claude Code permission strings.
//   read           → Read
//   grep           → Grep
//   glob           → Glob
//   edit           → Edit, MultiEdit
//   write          → Write
//   shell:<words>  → Bash(<words>:*)
function translateList(items: readonly string[]): string {
  const translated: string[] = [];
  for (const item of items) {
    if (item.startsWith("shell:")) {
      const prefix = item.slice("shell:".length).trim();
      if (prefix.length > 0) {
        translated.push(`Bash(${prefix}:*)`);
      }
      continue;
    }
    switch (item) {
      case "read":
        translated.push("Read");
        break;
      case "grep":
        translated.push("Grep");
        break;
      case "glob":
        translated.push("Glob");
        break;
      case "edit":
        translated.push("Edit", "MultiEdit");
        break;
      case "write":
        translated.push("Write");
        break;
      default:
        // Unknown tokens pass through so future vocabulary additions
        // remain forward-compatible without breaking existing runs.
        translated.push(item);
    }
  }
  return translated.join(" ");
}
