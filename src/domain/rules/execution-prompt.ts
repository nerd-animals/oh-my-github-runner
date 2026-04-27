import type { GitHubComment, GitHubSourceContext } from "../github.js";
import type {
  ExecutionMode,
  InstructionDefinition,
} from "../instruction.js";
import type { TaskRecord } from "../task.js";

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
        "- You may call GitHub APIs via `gh` for both reads and writes (post comments, open follow-up issues, look up cross-repo context).",
        "- You MUST NOT modify files in the workspace or run `git add` / `git commit` / `git push`. The workspace clone is a read-only reference.",
        "- Communication is your job: if the user expects a reply on this issue/PR, post it yourself via `gh issue comment` / `gh pr comment`. The runner does not write back for you.",
      ];
    }

    return [
      "- Mode: mutate",
      "- You may read and write files in the workspace, run `git add`, `git commit`, and `git push`.",
      "- The current branch is set up for you (typically `ai/<source-kind>-<number>`); push that branch directly with `git push -u origin HEAD`. Direct pushes to `main` are server-protected — every change to `main` must go through a pull request.",
      "- After pushing, open the PR yourself with `gh pr create` (or update an existing one with `gh pr edit` / a new commit). Pick a clear title and write the PR body — it is your output to the user.",
      "- You may also use `gh` for any side effects you judge useful: filing follow-up issues for out-of-scope work, commenting on the source issue/PR, adding labels, etc. The runner does not post anything for you besides a daemon-level failure notice if the task crashes.",
      "- If you conclude no file change is appropriate, exit cleanly. Communicate the reasoning to the user via `gh issue comment` / `gh pr comment` on the source so they see it on GitHub.",
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
