import type { CommandVerb } from "./command-parser.js";

export type EventKind = "issue_opened" | "issue_comment" | "pr_comment";

export interface RoutingInput {
  eventKind: EventKind;
  verb: CommandVerb;
}

export interface RoutingRule {
  match: (input: RoutingInput) => boolean;
  instructionId: string;
}

export const DEFAULT_ROUTING_RULES: RoutingRule[] = [
  {
    match: (input) => input.eventKind === "issue_opened",
    instructionId: "issue-initial-review",
  },
  {
    match: (input) =>
      input.eventKind === "issue_comment" && input.verb === "implement",
    instructionId: "issue-implement",
  },
  {
    match: (input) =>
      input.eventKind === "issue_comment" && input.verb === null,
    instructionId: "issue-comment-reply",
  },
  {
    match: (input) =>
      input.eventKind === "pr_comment" && input.verb === "implement",
    instructionId: "pr-implement",
  },
  {
    match: (input) =>
      input.eventKind === "pr_comment" && input.verb === null,
    instructionId: "pr-review-comment",
  },
];

export function resolveInstructionId(
  rules: readonly RoutingRule[],
  input: RoutingInput,
): string | null {
  for (const rule of rules) {
    if (rule.match(input)) {
      return rule.instructionId;
    }
  }

  return null;
}
