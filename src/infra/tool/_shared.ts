import type { RunProcessResult } from "../../domain/ports/process-runner.js";
import type { ToolRunInput, ToolRunResult } from "../../domain/tool.js";

// Common environment block surfaced to every tool subprocess.
// Tool runners inherit process.env then layer task identifiers and the
// installation token (so child agents can call `gh`/`git` against the repo).
export function buildBaseEnv(input: ToolRunInput): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RUNNER_TASK_ID: input.task.taskId,
    RUNNER_INSTRUCTION_ID: input.task.instructionId,
    RUNNER_REPO_OWNER: input.task.repo.owner,
    RUNNER_REPO_NAME: input.task.repo.name,
    ...(input.installationToken !== undefined
      ? {
          GH_TOKEN: input.installationToken,
          GITHUB_TOKEN: input.installationToken,
        }
      : {}),
  };
}

// Map a raw process result into the ToolRunResult shape. Non-zero exit
// becomes `failed` unless one of the supplied patterns matches the
// stdout+stderr haystack, in which case it is reported as `rate_limited`.
// Patterns are tool-specific and supplied by the concrete runner.
export function classifyResult(
  raw: RunProcessResult,
  toolName: string,
  rateLimitPatterns: readonly RegExp[],
): ToolRunResult {
  if (raw.exitCode === 0) {
    return { kind: "succeeded", stdout: raw.stdout };
  }

  const haystack = `${raw.stdout}\n${raw.stderr}`;
  for (const pattern of rateLimitPatterns) {
    if (pattern.test(haystack)) {
      return {
        kind: "rate_limited",
        toolName,
        signal: `pattern=${pattern.source}`,
      };
    }
  }

  return {
    kind: "failed",
    exitCode: raw.exitCode,
    stdout: raw.stdout,
    stderr: raw.stderr,
  };
}
