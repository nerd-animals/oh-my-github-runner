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
  | { kind: "user"; text: string }
  | { kind: "omgr-doc"; path: string };

export interface AiRunOptions {
  /**
   * Which tool to route this call to. Must be a key of the strategy's
   * `policies.uses`. May be omitted only when the strategy declares a
   * single tool (then it's inferred); strategies declaring multiple
   * tools must specify per call.
   */
  tool?: string;
  prompt: readonly PromptFragment[];
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  timeoutMs?: number;
}

export type AiRunResult =
  | { kind: "succeeded"; stdout: string }
  | { kind: "failed"; errorSummary: string }
  | { kind: "rate_limited"; toolName: string };

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
  | { status: "rate_limited"; toolName: string };

export interface StrategyPolicies {
  /**
   * Set of tools this strategy may route ai.run calls to. Keys are tool
   * names (e.g. "claude", "codex"); only `true` is allowed as
   * the value, so writing `{ claude: true }` reads as "uses claude".
   * The daemon defers a task until ALL tools listed here are clear of
   * any rate-limit cooldown.
   */
  uses: Record<string, true>;
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
