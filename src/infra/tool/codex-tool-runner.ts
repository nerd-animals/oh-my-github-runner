import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProcessRunner } from "../../domain/ports/process-runner.js";
import type { ToolRunner } from "../../domain/ports/tool-runner.js";
import type { ToolRunInput, ToolRunResult } from "../../domain/tool.js";
import { buildBaseEnv, classifyResult } from "./_shared.js";

export interface CodexFs {
  mkdir: (target: string, options: { recursive: true }) => Promise<unknown>;
  writeFile: (target: string, contents: string) => Promise<void>;
  rm: (
    target: string,
    options: { recursive: true; force: true },
  ) => Promise<void>;
}

export interface CodexToolRunnerOptions {
  command: string;
  processRunner: ProcessRunner;
  fs?: CodexFs;
}

// Codex CLI surfaces quota/rate-limit conditions through its websocket
// client; the wire phrasing observed so far matches the patterns below.
// Empty patterns just mean "no rate-limit detection yet" — quota errors
// will surface as ordinary `failed` results until a sample is captured
// in production and added here.
const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /rate.?limit/i,
  /"status":\s*429/,
  /quota.*exceeded/i,
];

export class CodexToolRunner implements ToolRunner {
  private readonly fs: CodexFs;

  constructor(private readonly options: CodexToolRunnerOptions) {
    this.fs = options.fs ?? {
      mkdir: (target, opts) => mkdir(target, opts),
      writeFile,
      rm,
    };
  }

  async run(input: ToolRunInput): Promise<ToolRunResult> {
    await this.writeRulesFile(input);

    const args = [
      "exec",
      "--sandbox",
      "workspace-write",
      "--ephemeral",
      "--skip-git-repo-check",
      "-C",
      input.workspacePath,
      "--",
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

    return classifyResult(raw, "codex", RATE_LIMIT_PATTERNS);
  }

  async cleanupArtifacts(workspacePath: string): Promise<void> {
    // Workspace dispose removes the directory anyway; this is a belt-and-
    // suspenders cleanup for the tool-private subdir, kept idempotent so
    // it's safe to call against already-removed paths.
    const target = path.join(workspacePath, ".codex");
    await this.fs.rm(target, { recursive: true, force: true });
  }

  private async writeRulesFile(input: ToolRunInput): Promise<void> {
    const blocks: string[] = [];
    for (const item of input.allowedTools ?? []) {
      const rule = toPrefixRule(item, "allow");
      if (rule !== null) blocks.push(rule);
    }
    for (const item of input.disallowedTools ?? []) {
      const rule = toPrefixRule(item, "forbidden");
      if (rule !== null) blocks.push(rule);
    }

    if (blocks.length === 0) return;

    const rulesDir = path.join(input.workspacePath, ".codex", "rules");
    await this.fs.mkdir(rulesDir, { recursive: true });
    await this.fs.writeFile(
      path.join(rulesDir, "default.rules"),
      blocks.join("\n\n") + "\n",
    );
  }
}

// `shell:<token-prefix>` → `prefix_rule(pattern=[...], decision="...")`.
// Built-in capabilities (read/edit/write) don't map to shell rules and
// return null. Tokens are split on whitespace; each becomes a literal
// element of the Starlark pattern list.
export function toPrefixRule(
  spec: string,
  decision: "allow" | "forbidden",
): string | null {
  if (!spec.startsWith("shell:")) {
    return null;
  }
  const prefix = spec.slice("shell:".length).trim();
  if (prefix.length === 0) return null;

  const tokens = prefix
    .split(/\s+/)
    .map((token) => JSON.stringify(token))
    .join(", ");

  return `prefix_rule(\n  pattern = [${tokens}],\n  decision = ${JSON.stringify(decision)},\n)`;
}
