import type { GitHubSourceContext } from "../domain/github.js";
import type { GitHubClient } from "../domain/ports/github-client.js";
import type { LogStore } from "../domain/ports/log-store.js";
import type { WorkspaceManager } from "../domain/ports/workspace-manager.js";
import { buildBranchName } from "../domain/rules/task-naming.js";
import type { RepoRef, TaskRecord } from "../domain/task.js";
import type { PromptRenderer } from "../infra/prompts/prompt-renderer.js";
import type {
  AiRunOptions,
  AiRunResult,
  DisposableMutateWorkspace,
  DisposableWorkspace,
  Toolkit,
} from "../strategies/types.js";
import type { ToolRegistry } from "./tool-registry.js";

export interface ToolkitFactoryOptions {
  githubClient: GitHubClient;
  workspaceManager: WorkspaceManager;
  toolRegistry: Pick<ToolRegistry, "resolve">;
  logStore: LogStore;
  promptRenderer: PromptRenderer;
  /**
   * Resolves the set of tool names a task may route to. Production wires
   * this to `Object.keys(getStrategy(task.instructionId).policies.uses)`.
   * The toolkit uses it for two things: validating `ai.run({ tool })`
   * against the strategy's declared set, and fanning out
   * `cleanupArtifacts` across every declared tool on workspace dispose.
   */
  toolsForTask: (task: TaskRecord) => readonly string[];
}

export class ToolkitFactory {
  constructor(private readonly options: ToolkitFactoryOptions) {}

  create(task: TaskRecord, signal?: AbortSignal): Toolkit {
    const declared = this.options.toolsForTask(task);
    if (declared.length === 0) {
      throw new Error(
        `Strategy for instructionId='${task.instructionId}' declares no tools (policies.uses is empty)`,
      );
    }
    return new ToolkitImpl(task, signal, this.options, declared);
  }
}

interface ActiveWorkspace {
  path: string;
  installationToken: string;
}

// Stateful per-task toolkit. Strategies prepare a workspace via
// `tk.workspace.prepare*`, then call `tk.ai.run(...)`. The toolkit
// remembers the most-recently-prepared workspace and routes ai.run
// through it. When the workspace is disposed (`await using` scope
// exit), the active slot is cleared.
class ToolkitImpl implements Toolkit {
  private active: ActiveWorkspace | null = null;
  private cachedContext: GitHubSourceContext | null = null;

  constructor(
    private readonly task: TaskRecord,
    private readonly signal: AbortSignal | undefined,
    private readonly options: ToolkitFactoryOptions,
    private readonly declaredTools: readonly string[],
  ) {}

  readonly github = {
    fetchContext: async (
      task: TaskRecord,
    ): Promise<GitHubSourceContext> => {
      if (this.cachedContext !== null) {
        return this.cachedContext;
      }
      const ctx = await this.options.githubClient.getSourceContext(
        task.repo,
        task.source,
        {
          includeIssueBody: true,
          includeIssueComments: true,
          includePrBody: true,
          includePrComments: true,
          includePrDiff: true,
        },
      );
      this.cachedContext = ctx;
      return ctx;
    },

    getDefaultBranch: (repo: RepoRef): Promise<string> =>
      this.options.githubClient.getDefaultBranch(repo),

    postIssueComment: async (
      repo: RepoRef,
      issueNumber: number,
      body: string,
    ): Promise<void> => {
      await this.options.githubClient.postIssueComment(
        repo,
        issueNumber,
        body,
      );
    },

    postPrComment: async (
      repo: RepoRef,
      prNumber: number,
      body: string,
    ): Promise<void> => {
      await this.options.githubClient.postPullRequestComment(
        repo,
        prNumber,
        body,
      );
    },

    createIssue: (
      repo: RepoRef,
      title: string,
      body: string,
    ): Promise<{ number: number; url: string }> =>
      this.options.githubClient.createIssue(repo, title, body),

    closeIssue: (repo: RepoRef, issueNumber: number): Promise<void> =>
      this.options.githubClient.closeIssue(repo, issueNumber),
  };

  readonly workspace = {
    prepareObserve: async (
      task: TaskRecord,
      checkoutRef?: string,
    ): Promise<DisposableWorkspace> => {
      const installationToken =
        await this.options.githubClient.getInstallationAccessToken(task.repo);
      const handle =
        await this.options.workspaceManager.prepareObserveWorkspace(
          task,
          checkoutRef,
          installationToken,
        );
      return this.makeDisposable({
        path: handle.workspacePath,
        installationToken,
        cleanup: async () => {
          await this.options.workspaceManager.cleanupWorkspace(handle);
          await this.cleanupToolArtifacts(handle.workspacePath);
        },
      });
    },

    prepareMutate: async (
      task: TaskRecord,
      opts?: { baseBranch?: string },
    ): Promise<DisposableMutateWorkspace> => {
      const baseBranch =
        opts?.baseBranch ??
        (await this.options.githubClient.getDefaultBranch(task.repo));
      const branchName = buildBranchName(task);
      const installationToken =
        await this.options.githubClient.getInstallationAccessToken(task.repo);
      const handle = await this.options.workspaceManager.prepareMutateWorkspace(
        task.repo,
        task,
        baseBranch,
        branchName,
        installationToken,
      );
      return this.makeDisposableMutate({
        path: handle.workspacePath,
        branchName: handle.branchName,
        baseBranch,
        installationToken,
        cleanup: async () => {
          await this.options.workspaceManager.cleanupWorkspace(handle);
          await this.cleanupToolArtifacts(handle.workspacePath);
        },
      });
    },

    preparePrImplement: async (
      task: TaskRecord,
      headRef: string,
    ): Promise<DisposableMutateWorkspace> => {
      const installationToken =
        await this.options.githubClient.getInstallationAccessToken(task.repo);
      const handle =
        await this.options.workspaceManager.preparePrImplementWorkspace(
          task.repo,
          task,
          headRef,
          installationToken,
        );
      return this.makeDisposableMutate({
        path: handle.workspacePath,
        branchName: handle.branchName,
        baseBranch: headRef,
        installationToken,
        cleanup: async () => {
          await this.options.workspaceManager.cleanupWorkspace(handle);
          await this.cleanupToolArtifacts(handle.workspacePath);
        },
      });
    },
  };

  // Fan-out cleanup across every tool the strategy declared. Each
  // runner's cleanupArtifacts is a no-op when there's nothing to clean,
  // so iterating over the declared set is safe even for tools that
  // never actually ran during this task.
  private async cleanupToolArtifacts(workspacePath: string): Promise<void> {
    for (const toolName of this.declaredTools) {
      try {
        await this.options.toolRegistry
          .resolve(toolName)
          .cleanupArtifacts(workspacePath);
      } catch (error) {
        console.warn(
          `[toolkit] cleanupArtifacts failed for task=${this.task.taskId} tool=${toolName}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  readonly ai = {
    run: async (opts: AiRunOptions): Promise<AiRunResult> => {
      if (this.active === null) {
        return {
          kind: "failed",
          errorSummary:
            "ai.run called before workspace was prepared - call tk.workspace.prepare* first",
        };
      }
      if (this.cachedContext === null) {
        return {
          kind: "failed",
          errorSummary:
            "ai.run called before context was fetched - call tk.github.fetchContext first",
        };
      }
      const toolName = this.resolveTool(opts);
      if (toolName === null) {
        return {
          kind: "failed",
          errorSummary: `ai.run requires opts.tool when strategy declares multiple tools (declared: ${this.declaredTools.join(", ")})`,
        };
      }
      if (!this.declaredTools.includes(toolName)) {
        return {
          kind: "failed",
          errorSummary: `ai.run: tool '${toolName}' is not in strategy's declared uses (${this.declaredTools.join(", ")})`,
        };
      }
      const promptText = await this.options.promptRenderer.render(
        opts.prompt,
        this.cachedContext,
        this.active.path,
      );
      const result = await this.options.toolRegistry.resolve(toolName).run({
        task: this.task,
        workspacePath: this.active.path,
        prompt: promptText,
        installationToken: this.active.installationToken,
        ...(opts.allowedTools !== undefined
          ? { allowedTools: opts.allowedTools }
          : {}),
        ...(opts.disallowedTools !== undefined
          ? { disallowedTools: opts.disallowedTools }
          : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.outputSchema !== undefined
          ? { outputSchema: opts.outputSchema }
          : {}),
        ...(this.signal !== undefined ? { signal: this.signal } : {}),
      });
      if (result.kind === "succeeded") {
        return { kind: "succeeded", stdout: result.stdout };
      }
      if (result.kind === "rate_limited") {
        return { kind: "rate_limited", toolName: result.toolName };
      }
      const errorSummary =
        (result.stderr || result.stdout).trim() || "tool execution failed";
      return { kind: "failed", errorSummary };
    },
  };

  readonly log = {
    write: async (message: string): Promise<void> => {
      await this.options.logStore.write(this.task.taskId, message);
    },
  };

  private resolveTool(opts: AiRunOptions): string | null {
    if (opts.tool !== undefined) {
      return opts.tool;
    }
    if (this.declaredTools.length === 1) {
      return this.declaredTools[0]!;
    }
    return null;
  }

  private makeDisposable(input: {
    path: string;
    installationToken: string;
    cleanup: () => Promise<void>;
  }): DisposableWorkspace {
    const active: ActiveWorkspace = {
      path: input.path,
      installationToken: input.installationToken,
    };
    this.active = active;

    return {
      path: input.path,
      installationToken: input.installationToken,
      [Symbol.asyncDispose]: async () => {
        try {
          await input.cleanup();
        } finally {
          if (this.active === active) {
            this.active = null;
          }
        }
      },
    };
  }

  private makeDisposableMutate(input: {
    path: string;
    branchName: string;
    baseBranch: string;
    installationToken: string;
    cleanup: () => Promise<void>;
  }): DisposableMutateWorkspace {
    const active: ActiveWorkspace = {
      path: input.path,
      installationToken: input.installationToken,
    };
    this.active = active;

    return {
      path: input.path,
      branchName: input.branchName,
      baseBranch: input.baseBranch,
      installationToken: input.installationToken,
      [Symbol.asyncDispose]: async () => {
        try {
          await input.cleanup();
        } finally {
          if (this.active === active) {
            this.active = null;
          }
        }
      },
    };
  }
}
