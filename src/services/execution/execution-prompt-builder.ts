import type { GitHubComment, GitHubSourceContext } from "../../domain/github.js";
import type {
  ExecutionMode,
  InstructionDefinition,
} from "../../domain/instruction.js";
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
      "Policy:",
      ...this.buildPolicyLines(instruction.mode),
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

      this.appendAdditionalInstructions(lines, task.additionalInstructions);
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
    this.appendAdditionalInstructions(lines, task.additionalInstructions);
    return lines.join("\n");
  }

  private buildPolicyLines(mode: ExecutionMode): string[] {
    if (mode === "observe") {
      return [
        "- Mode: observe",
        "- You may read files in the workspace.",
        "- You may call GitHub APIs via `gh` (issue/PR/comment read AND write, cross-repo issue lookup).",
        "- You MUST NOT modify files in the workspace, run `git add`, `git commit`, or `git push`.",
        "- Use the workspace clone only as a read-only reference.",
      ];
    }

    return [
      "- Mode: mutate",
      "- You may read and write files in the workspace.",
      "- You may run `git add`, `git commit`. The runner pushes for you.",
      "- You may call GitHub APIs via `gh` for read-only context. The runner publishes the PR.",
    ];
  }

  private appendAdditionalInstructions(
    lines: string[],
    additional: string | undefined,
  ): void {
    if (additional === undefined || additional.length === 0) {
      return;
    }

    lines.push("", "User additional instructions:", additional);
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
