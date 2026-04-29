import type { GitHubSourceContext } from "../../domain/github.js";
import type { TaskRecord } from "../../domain/task.js";
import type { AiRunResult, ExecuteResult } from "../types.js";

export function header(
  task: TaskRecord,
  context: GitHubSourceContext,
): string {
  return [
    `Instruction: ${task.instructionId}`,
    `Repository: ${task.repo.owner}/${task.repo.name}`,
    `Source: ${task.source.kind} #${task.source.number}`,
    `Title: ${context.title}`,
  ].join("\n");
}

export function ok(): ExecuteResult {
  return { status: "succeeded" };
}

export function mapAiFailure(result: AiRunResult): ExecuteResult {
  if (result.kind === "succeeded") {
    return ok();
  }
  if (result.kind === "rate_limited") {
    return { status: "rate_limited", agentName: result.agentName };
  }
  return { status: "failed", errorSummary: result.errorSummary };
}
