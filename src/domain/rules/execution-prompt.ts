import type {
  GitHubComment,
  GitHubSourceContext,
  LinkedRefEntry,
  LinkedRefs,
} from "../github.js";
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
  personas: Record<string, string>;
  modePolicies: ModePolicies;
}

export class ExecutionPromptBuilder {
  private readonly commonRules: string;
  private readonly personas: Record<string, string>;
  private readonly modePolicies: ModePolicies;

  constructor(options: ExecutionPromptBuilderOptions) {
    this.commonRules = options.commonRules.trim();
    this.personas = options.personas;
    this.modePolicies = options.modePolicies;
  }

  build(input: BuildExecutionPromptInput): string {
    const sections: string[] = [];

    const preamble = this.renderPreamble(input.instruction);
    if (preamble !== null) sections.push(preamble);

    sections.push(this.renderHeader(input));
    sections.push(this.renderPolicy(input.instruction.mode));

    const guidance = this.renderGuidance(input.instruction);
    if (guidance !== null) sections.push(guidance);

    sections.push(this.renderData(input.context, input.instruction));

    const userAdditional = this.renderUserAdditional(
      input.task.additionalInstructions,
    );
    if (userAdditional !== null) sections.push(userAdditional);

    return sections.join("\n\n");
  }

  private renderPreamble(instruction: InstructionDefinition): string | null {
    const persona = this.personas[instruction.persona];
    if (persona === undefined) {
      throw new Error(
        `Unknown persona '${instruction.persona}' for instruction '${instruction.id}'`,
      );
    }
    const parts = [this.commonRules, persona.trim()].filter(
      (part) => part.length > 0,
    );
    if (parts.length === 0) return null;
    return parts.join("\n\n");
  }

  private renderHeader(input: BuildExecutionPromptInput): string {
    const { task, context, instruction } = input;
    return [
      `Instruction: ${instruction.id}`,
      `Repository: ${task.repo.owner}/${task.repo.name}`,
      `Source: ${task.source.kind} #${task.source.number}`,
      `Title: ${context.title}`,
    ].join("\n");
  }

  private renderPolicy(mode: ExecutionMode): string {
    return ["Policy:", this.modePolicies[mode].trim()].join("\n");
  }

  private renderGuidance(instruction: InstructionDefinition): string | null {
    if (instruction.guidance === undefined || instruction.guidance.length === 0) {
      return null;
    }
    return ["Instruction guidance:", instruction.guidance.trim()].join("\n");
  }

  private renderData(
    context: GitHubSourceContext,
    instruction: InstructionDefinition,
  ): string {
    const blocks: string[] = [];

    if (context.kind === "issue") {
      if (instruction.context.includeIssueBody === true) {
        blocks.push(renderBodyBlock(context.body));
      }
      if (instruction.context.includeIssueComments === true) {
        blocks.push(renderCommentsBlock(context.comments));
      }
      blocks.push(renderLinkedRefsBlock(context.linkedRefs, "issue"));
      return blocks.join("\n\n");
    }

    if (instruction.context.includePrBody === true) {
      blocks.push(renderBodyBlock(context.body));
    }
    if (instruction.context.includePrComments === true) {
      blocks.push(renderCommentsBlock(context.comments));
    }
    if (instruction.context.includePrDiff === true) {
      blocks.push(`Diff:\n${context.diff}`);
    }
    blocks.push(`Base: ${context.baseRef}\nHead: ${context.headRef}`);
    blocks.push(renderLinkedRefsBlock(context.linkedRefs, "pull_request"));
    return blocks.join("\n\n");
  }

  private renderUserAdditional(
    additional: string | undefined,
  ): string | null {
    if (additional === undefined || additional.length === 0) return null;
    return `User additional instructions:\n${additional}`;
  }
}

function renderBodyBlock(body: string): string {
  return `Body:\n${body}`;
}

function renderCommentsBlock(comments: GitHubComment[]): string {
  const lines =
    comments.length > 0
      ? comments.map((comment) => `- ${comment.author}: ${comment.body}`)
      : ["- none"];
  return ["Comments:", ...lines].join("\n");
}

function renderLinkedRefsBlock(
  linkedRefs: LinkedRefs,
  sourceKind: "issue" | "pull_request",
): string {
  const closesHeader =
    sourceKind === "issue"
      ? "Linked PRs (closes):"
      : "Linked Issues (closes):";

  const closesLines =
    linkedRefs.closes.length > 0
      ? linkedRefs.closes.map(formatLinkedRefEntry)
      : ["- none"];

  const sections: string[] = [[closesHeader, ...closesLines].join("\n")];

  if (linkedRefs.bodyMentions.length > 0) {
    sections.push(
      [
        "Referenced (body mentions):",
        ...linkedRefs.bodyMentions.map(formatLinkedRefEntry),
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

function formatLinkedRefEntry(entry: LinkedRefEntry): string {
  const stateLabel =
    entry.kind === "pull_request" && entry.merged === true
      ? "merged"
      : entry.state;
  const kindLabel = entry.kind === "pull_request" ? "pr" : "issue";
  return `- ${kindLabel} #${entry.number} (${stateLabel}) — ${entry.title}`;
}
