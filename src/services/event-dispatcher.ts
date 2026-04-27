import type { RepoRef, SourceRef } from "../domain/task.js";
import type { AgentRegistry } from "./agent-registry.js";
import { parseCommand } from "../domain/rules/command-parser.js";

export interface PullRequestState {
  number: number;
  isFork: boolean;
  state: "open" | "closed";
  merged: boolean;
  headRef: string | null;
}

export type DispatchedEvent =
  | {
      kind: "issue_opened";
      repo: RepoRef;
      issue: { number: number; labels: string[] };
      sender: { id: number; login: string };
    }
  | {
      kind: "issue_comment";
      repo: RepoRef;
      issue: { number: number };
      comment: { body: string };
      sender: { id: number; login: string };
    }
  | {
      kind: "pr_comment";
      repo: RepoRef;
      pr: PullRequestState;
      comment: { body: string };
      sender: { id: number; login: string };
    };

export interface RejectionComment {
  repo: RepoRef;
  issueNumber: number;
  body: string;
}

export type DispatchAction =
  | {
      kind: "enqueue";
      instructionId: string;
      agent: string;
      repo: RepoRef;
      source: SourceRef;
      additionalInstructions?: string;
      requestedBy: string;
    }
  | { kind: "ignore"; reason: string }
  | { kind: "reject"; reason: string; comment: RejectionComment };

export interface EventDispatcherDependencies {
  agentRegistry: Pick<AgentRegistry, "has" | "getDefaultAgent">;
  botUserId: number;
  noAiLabel?: string;
}

const DEFAULT_NO_AI_LABEL = "no-ai";

export class EventDispatcher {
  private readonly noAiLabel: string;

  constructor(private readonly deps: EventDispatcherDependencies) {
    this.noAiLabel = deps.noAiLabel ?? DEFAULT_NO_AI_LABEL;
  }

  dispatch(event: DispatchedEvent): DispatchAction {
    if (event.sender.id === this.deps.botUserId) {
      return { kind: "ignore", reason: "sender is our app's bot" };
    }

    if (event.kind === "issue_opened") {
      return this.dispatchIssueOpened(event);
    }

    if (event.kind === "issue_comment") {
      return this.dispatchIssueComment(event);
    }

    return this.dispatchPullRequestComment(event);
  }

  private dispatchIssueOpened(
    event: Extract<DispatchedEvent, { kind: "issue_opened" }>,
  ): DispatchAction {
    if (event.issue.labels.includes(this.noAiLabel)) {
      return {
        kind: "ignore",
        reason: `'${this.noAiLabel}' label suppresses auto-trigger`,
      };
    }

    return {
      kind: "enqueue",
      instructionId: "issue-initial-review",
      agent: this.deps.agentRegistry.getDefaultAgent(),
      repo: event.repo,
      source: { kind: "issue", number: event.issue.number },
      requestedBy: event.sender.login,
    };
  }

  private dispatchIssueComment(
    event: Extract<DispatchedEvent, { kind: "issue_comment" }>,
  ): DispatchAction {
    const parsed = parseCommand(event.comment.body);

    if (parsed === null) {
      return { kind: "ignore", reason: "no command in comment" };
    }

    if (!this.deps.agentRegistry.has(parsed.agent)) {
      return {
        kind: "ignore",
        reason: `agent '${parsed.agent}' is not registered`,
      };
    }

    const instructionId =
      parsed.verb === "implement" ? "issue-implement" : "issue-comment-reply";

    return {
      kind: "enqueue",
      instructionId,
      agent: parsed.agent,
      repo: event.repo,
      source: { kind: "issue", number: event.issue.number },
      requestedBy: event.sender.login,
      ...(parsed.additionalInstructions.length > 0
        ? { additionalInstructions: parsed.additionalInstructions }
        : {}),
    };
  }

  private dispatchPullRequestComment(
    event: Extract<DispatchedEvent, { kind: "pr_comment" }>,
  ): DispatchAction {
    const parsed = parseCommand(event.comment.body);

    if (parsed === null) {
      return { kind: "ignore", reason: "no command in comment" };
    }

    if (!this.deps.agentRegistry.has(parsed.agent)) {
      return {
        kind: "ignore",
        reason: `agent '${parsed.agent}' is not registered`,
      };
    }

    if (parsed.verb === "implement") {
      const rejection = this.preflightPullRequest(event);

      if (rejection !== null) {
        return rejection;
      }

      return {
        kind: "enqueue",
        instructionId: "pr-implement",
        agent: parsed.agent,
        repo: event.repo,
        source: { kind: "pull_request", number: event.pr.number },
        requestedBy: event.sender.login,
        ...(parsed.additionalInstructions.length > 0
          ? { additionalInstructions: parsed.additionalInstructions }
          : {}),
      };
    }

    return {
      kind: "enqueue",
      instructionId: "pr-review-comment",
      agent: parsed.agent,
      repo: event.repo,
      source: { kind: "pull_request", number: event.pr.number },
      requestedBy: event.sender.login,
      ...(parsed.additionalInstructions.length > 0
        ? { additionalInstructions: parsed.additionalInstructions }
        : {}),
    };
  }

  private preflightPullRequest(
    event: Extract<DispatchedEvent, { kind: "pr_comment" }>,
  ): DispatchAction | null {
    if (event.pr.isFork) {
      return {
        kind: "reject",
        reason: "PR is from a fork",
        comment: {
          repo: event.repo,
          issueNumber: event.pr.number,
          body: "Cannot run `/claude implement`: PRs from forks are not supported in v1.",
        },
      };
    }

    if (event.pr.merged) {
      return {
        kind: "reject",
        reason: "PR is already merged",
        comment: {
          repo: event.repo,
          issueNumber: event.pr.number,
          body: "Cannot run `/claude implement`: this PR is already merged.",
        },
      };
    }

    if (event.pr.state === "closed") {
      return {
        kind: "reject",
        reason: "PR is closed",
        comment: {
          repo: event.repo,
          issueNumber: event.pr.number,
          body: "Cannot run `/claude implement`: this PR is closed.",
        },
      };
    }

    if (event.pr.headRef === null) {
      return {
        kind: "reject",
        reason: "PR head branch has been deleted",
        comment: {
          repo: event.repo,
          issueNumber: event.pr.number,
          body: "Cannot run `/claude implement`: head branch has been deleted.",
        },
      };
    }

    return null;
  }
}
