import type { GitHubSourceContext } from "../domain/github.js";
import type { RepoRef, TaskRecord } from "../domain/task.js";

export type ContextKey =
  | "issue-body"
  | "issue-comments"
  | "pr-body"
  | "pr-comments"
  | "pr-diff"
  | "pr-base-head"
  | "linked-refs";

export type PromptFragment =
  | { kind: "file"; path: string }
  | { kind: "literal"; text: string }
  | { kind: "context"; key: ContextKey }
  | { kind: "user"; text: string };

export interface AiRunOptions {
  agent: string;
  prompt: readonly PromptFragment[];
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  timeoutMs?: number;
}

export type AiRunResult =
  | { kind: "succeeded"; stdout: string }
  | { kind: "failed"; errorSummary: string }
  | { kind: "rate_limited"; agentName: string };

export interface DisposableWorkspace extends AsyncDisposable {
  readonly path: string;
  readonly installationToken: string;
}

export interface DisposableMutateWorkspace extends DisposableWorkspace {
  readonly branchName: string;
  readonly baseBranch: string;
}

export interface Toolkit {
  github: {
    fetchContext(task: TaskRecord): Promise<GitHubSourceContext>;
    getDefaultBranch(repo: RepoRef): Promise<string>;
    postIssueComment(
      repo: RepoRef,
      issueNumber: number,
      body: string,
    ): Promise<void>;
    postPrComment(
      repo: RepoRef,
      prNumber: number,
      body: string,
    ): Promise<void>;
  };
  workspace: {
    prepareObserve(
      task: TaskRecord,
      checkoutRef?: string,
    ): Promise<DisposableWorkspace>;
    prepareMutate(
      task: TaskRecord,
      opts?: { baseBranch?: string },
    ): Promise<DisposableMutateWorkspace>;
    preparePrImplement(
      task: TaskRecord,
      headRef: string,
    ): Promise<DisposableMutateWorkspace>;
  };
  ai: {
    run(opts: AiRunOptions): Promise<AiRunResult>;
  };
  log: {
    write(message: string): Promise<void>;
  };
}

export type ExecuteResult =
  | { status: "succeeded" }
  | { status: "failed"; errorSummary: string }
  | { status: "rate_limited"; agentName: string };

export interface StrategyPolicies {
  /** EnqueueService cancels prior active tasks on the same (repo, source). */
  supersedeOnSameSource: boolean;
  /** Per-call ai.run timeout default (replaces yaml `execution.timeout_sec`). */
  timeoutMs: number;
}

export interface Strategy {
  policies: StrategyPolicies;
  run(
    task: TaskRecord,
    tk: Toolkit,
    signal: AbortSignal,
  ): Promise<ExecuteResult>;
}
