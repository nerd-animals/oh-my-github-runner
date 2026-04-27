import type { RepoRef, SourceRef } from "../domain/task.js";
import { parseCommand } from "../domain/rules/command-parser.js";
import {
  DEFAULT_ROUTING_RULES,
  resolveInstructionId,
  type RoutingRule,
} from "../domain/rules/event-routing.js";
import type { AgentRegistry } from "./agent-registry.js";

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
  allowedSenderIds: ReadonlySet<number>;
  noAiLabel?: string;
  routingRules?: readonly RoutingRule[];
}

const DEFAULT_NO_AI_LABEL = "no-ai";

export class EventDispatcher {
  private readonly noAiLabel: string;
  private readonly routingRules: readonly RoutingRule[];

  constructor(private readonly deps: EventDispatcherDependencies) {
    this.noAiLabel = deps.noAiLabel ?? DEFAULT_NO_AI_LABEL;
    this.routingRules = deps.routingRules ?? DEFAULT_ROUTING_RULES;
  }

  dispatch(event: DispatchedEvent): DispatchAction {
    if (event.sender.id === this.deps.botUserId) {
      return { kind: "ignore", reason: "sender is our app's bot" };
    }

    if (!this.deps.allowedSenderIds.has(event.sender.id)) {
      return {
        kind: "ignore",
        reason: `sender id ${event.sender.id} (login=${event.sender.login}) not in allowlist`,
      };
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

    const instructionId = resolveInstructionId(this.routingRules, {
      eventKind: "issue_opened",
      verb: null,
    });

    if (instructionId === null) {
      return { kind: "ignore", reason: "no routing rule matched" };
    }

    return {
      kind: "enqueue",
      instructionId,
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

    const instructionId = resolveInstructionId(this.routingRules, {
      eventKind: "issue_comment",
      verb: parsed.verb,
    });

    if (instructionId === null) {
      return { kind: "ignore", reason: "no routing rule matched" };
    }

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
    }

    const instructionId = resolveInstructionId(this.routingRules, {
      eventKind: "pr_comment",
      verb: parsed.verb,
    });

    if (instructionId === null) {
      return { kind: "ignore", reason: "no routing rule matched" };
    }

    return {
      kind: "enqueue",
      instructionId,
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
