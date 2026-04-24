import type { GitHubComment, GitHubSourceContext } from "../../domain/github.js";
import type { InstructionDefinition } from "../../domain/instruction.js";
import type { TaskRecord } from "../../domain/task.js";

export interface BuildExecutionPromptInput {
  task: TaskRecord;
  instruction: InstructionDefinition;
  context: GitHubSourceContext;
}

export class ExecutionPromptBuilder {
  build(input: BuildExecutionPromptInput): string {
    const { context, instruction, task } = input;
    const lines = [
      `Instruction: ${instruction.id}`,
      `Mode: ${instruction.mode}`,
      `Repository: ${task.repo.owner}/${task.repo.name}`,
      `Source: ${task.source.kind} #${task.source.number}`,
      `Title: ${context.title}`,
    ];

    if (context.kind === "issue") {
      if (instruction.context.includeIssueBody === true) {
        this.appendBodySection(lines, context.body);
      }

      if (instruction.context.includeIssueComments === true) {
        this.appendCommentsSection(lines, context.comments);
      }

      return lines.join("\n");
    }

    if (instruction.context.includePrBody === true) {
      this.appendBodySection(lines, context.body);
    }

    if (instruction.context.includePrComments === true) {
      this.appendCommentsSection(lines, context.comments);
    }

    if (instruction.context.includePrDiff === true) {
      lines.push("", "Diff:", context.diff);
    }

    lines.push("", `Base: ${context.baseRef}`, `Head: ${context.headRef}`);
    return lines.join("\n");
  }

  private appendBodySection(lines: string[], body: string): void {
    lines.push("", "Body:", body);
  }

  private appendCommentsSection(lines: string[], comments: GitHubComment[]): void {
    lines.push(
      "",
      "Comments:",
      ...(comments.length > 0
        ? comments.map((comment) => `- ${comment.author}: ${comment.body}`)
        : ["- none"]),
    );
  }
}
