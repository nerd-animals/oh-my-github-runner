import type { InstructionDefinition } from "../instruction.js";
import type { TaskRecord } from "../task.js";

export function buildBranchName(task: TaskRecord): string {
  return `ai/${task.source.kind}-${task.source.number}`;
}

export function buildCommitMessage(task: TaskRecord): string {
  return `feat: address ${task.source.kind} #${task.source.number}`;
}

export function buildPullRequestTitle(task: TaskRecord): string {
  if (task.source.kind === "issue") {
    return `Resolve issue #${task.source.number}`;
  }

  return `Follow up for PR #${task.source.number}`;
}

export function withInstructionFooter(
  body: string,
  instruction: InstructionDefinition,
): string {
  const trimmedBody = body.length > 0 ? body : "No summary provided.";
  return `${trimmedBody}\n\n_Instruction: ${instruction.id} r${instruction.revision}_`;
}
