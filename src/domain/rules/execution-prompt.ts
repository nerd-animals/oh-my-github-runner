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

export type ModePolicies = Record<ExecutionMode, string>;

export interface ExecutionPromptBuilderOptions {
  commonRules: string;
  persona: string;
  modePolicies: ModePolicies;
}

export class ExecutionPromptBuilder {
  private readonly preamble: string;
  private readonly modePolicies: ModePolicies;

  constructor(options: ExecutionPromptBuilderOptions) {
    this.preamble = [options.commonRules, options.persona]
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join("\n\n");
    this.modePolicies = options.modePolicies;
  }

  build(input: BuildExecutionPromptInput): string {
    const { context, instruction, task } = input;
    const policy = this.modePolicies[instruction.mode].trim();
    const lines = [
      `Instruction: ${instruction.id}`,
      "Policy:",
      policy,
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
      return this.withPreamble(lines.join("\n"));
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
    return this.withPreamble(lines.join("\n"));
  }

  private withPreamble(core: string): string {
    if (this.preamble.length === 0) {
      return core;
    }
    return `${this.preamble}\n\n${core}`;
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
