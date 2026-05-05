import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProcessRunner } from "../../domain/ports/process-runner.js";
import type { ToolRunner } from "../../domain/ports/tool-runner.js";
import type {
  Intensity,
  ToolRunInput,
  ToolRunResult,
} from "../../domain/tool.js";
import { buildBaseEnv, classifyResult } from "./_shared.js";

// Codex CLI's `model_reasoning_effort` config keys (see codex
// config-reference). The runner does not pick values; the injected
// intensity map decides which keys are used per Intensity step.
export type CodexReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface CodexIntensityPreset {
  model: string;
  reasoningEffort: CodexReasoningEffort;
}

export type CodexIntensityMap = Readonly<
  Record<Intensity, CodexIntensityPreset>
>;

export interface CodexFs {
  mkdir: (target: string, options: { recursive: true }) => Promise<unknown>;
  writeFile: (target: string, contents: string) => Promise<void>;
  readFile: (target: string) => Promise<string>;
  rm: (
    target: string,
    options: { recursive: true; force: true },
  ) => Promise<void>;
}

export interface CodexToolRunnerOptions {
  command: string;
  processRunner: ProcessRunner;
  // Maps the strategy-facing `Intensity` to a model/effort pair. The
  // runner stays policy-free; production wiring picks the values.
  intensityMap: CodexIntensityMap;
  fs?: CodexFs;
}

// Match only explicit rate-limit signals. A bare `/rate.?limit/i` substring
// matched ordinary failure logs ("rate-limit-exempt path", debug noise,
// echoed user comments) and promoted them to `rate_limited`, which the
// daemon then paused for an hour. Under-detection (a real rate-limit
// surfaces as `failed`) is cheaper than over-detection here — a failed
// task is retried immediately by the user, while an oversold rate-limit
// stalls the queue. The first pattern is the production sample from
// codex CLI (#107).
const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /You've hit your.*usage limit/i,
  /\bRATE_LIMIT_EXCEEDED\b/,
  /"status":\s*429\b/,
  /\bHTTP\s+429\b/,
  /\bRetry-After:\s*\d+/i,
  /\bquota\s+exceeded\b/i,
];

export class CodexToolRunner implements ToolRunner {
  private readonly fs: CodexFs;

  constructor(private readonly options: CodexToolRunnerOptions) {
    this.fs = options.fs ?? {
      mkdir: (target, opts) => mkdir(target, opts),
      writeFile,
      readFile: (target) => readFile(target, "utf8"),
      rm,
    };
  }

  async run(input: ToolRunInput): Promise<ToolRunResult> {
    await this.writeRulesFile(input);
    const lastMessagePath = await this.prepareOutputSchema(input);

    const preset =
      this.options.intensityMap[input.intensity ?? "medium"];
    const args = [
      "exec",
      "-m",
      preset.model,
      "-c",
      `model_reasoning_effort=${preset.reasoningEffort}`,
      "--sandbox",
      "workspace-write",
      "--ephemeral",
      "--skip-git-repo-check",
      "-C",
      input.workspacePath,
    ];
    if (lastMessagePath !== null) {
      const schemaPath = path.join(input.workspacePath, ".codex", "output.schema.json");
      args.push(
        "--output-schema",
        schemaPath,
        "-o",
        lastMessagePath,
      );
    }
    // Pass the prompt body via stdin instead of argv. argv totals are
    // capped by the kernel's ARG_MAX (~2 MiB on Linux); large publisher
    // prompts (multi-persona results + omgr docs + diff context) can
    // approach that limit and crash spawn() with E2BIG. `codex exec`
    // reads instructions from stdin when the positional prompt is `-`.
    args.push("--", "-");

    const raw = await this.options.processRunner.run({
      command: this.options.command,
      args,
      cwd: input.workspacePath,
      stdin: input.prompt,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      env: buildBaseEnv(input),
    });

    // When outputSchema was used and the run succeeded, the schema-conformant
    // JSON is written to `last-message.txt` rather than coming back through
    // stdout. Read that file and surface its contents as the succeeded stdout
    // so callers always parse the structured payload from a single place.
    if (lastMessagePath !== null && raw.exitCode === 0) {
      try {
        const stdout = await this.fs.readFile(lastMessagePath);
        if (stdout.trim().length === 0) {
          // File present but empty: codex accepted the run but emitted no
          // schema-conformant message. Surface as failed with raw stdout/
          // stderr so the receipt shows codex's actual logs instead of an
          // opaque "Unexpected end of JSON input" downstream.
          return {
            kind: "failed",
            exitCode: 0,
            stdout: raw.stdout,
            stderr:
              raw.stderr.length > 0
                ? raw.stderr
                : "codex wrote an empty last-message.txt despite outputSchema",
          };
        }
        return { kind: "succeeded", stdout };
      } catch {
        // File missing despite exit 0 — fall through to raw result so the
        // caller sees the original stdout/stderr instead of a silent empty
        // success.
      }
    }

    return classifyResult(raw, "codex", RATE_LIMIT_PATTERNS);
  }

  // Materialize the JSON Schema in the workspace's `.codex/` dir and
  // return the absolute path the runner should pass to `codex exec -o`,
  // or `null` when no schema was requested. Returning the path keeps the
  // arg-construction site below free of fs concerns.
  private async prepareOutputSchema(
    input: ToolRunInput,
  ): Promise<string | null> {
    if (input.outputSchema === undefined) {
      return null;
    }
    const codexDir = path.join(input.workspacePath, ".codex");
    const schemaPath = path.join(codexDir, "output.schema.json");
    const lastMessagePath = path.join(codexDir, "last-message.txt");
    await this.fs.mkdir(codexDir, { recursive: true });
    await this.fs.writeFile(
      schemaPath,
      JSON.stringify(input.outputSchema, null, 2) + "\n",
    );
    return lastMessagePath;
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
