import type { GitHubSourceContext } from "../domain/github.js";
import type { CleanupAgentArtifacts } from "../domain/ports/agent-artifact-cleaner.js";
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
import type { AgentRegistry } from "./agent-registry.js";

export interface ToolkitFactoryOptions {
  githubClient: GitHubClient;
  workspaceManager: WorkspaceManager;
  agentRegistry: Pick<AgentRegistry, "resolve">;
  logStore: LogStore;
  promptRenderer: PromptRenderer;
  cleanupAgentArtifacts: CleanupAgentArtifacts;
}

export class ToolkitFactory {
  constructor(private readonly options: ToolkitFactoryOptions) {}

  create(task: TaskRecord, signal?: AbortSignal): Toolkit {
    return new ToolkitImpl(task, signal, this.options);
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
          await this.options.cleanupAgentArtifacts(handle.workspacePath);
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
          await this.options.cleanupAgentArtifacts(handle.workspacePath);
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
          await this.options.cleanupAgentArtifacts(handle.workspacePath);
        },
      });
    },
  };

  readonly ai = {
    run: async (opts: AiRunOptions): Promise<AiRunResult> => {
      if (this.active === null) {
        return {
          kind: "failed",
          errorSummary:
            "ai.run called before workspace was prepared — call tk.workspace.prepare* first",
        };
      }
      if (this.cachedContext === null) {
        return {
          kind: "failed",
          errorSummary:
            "ai.run called before context was fetched — call tk.github.fetchContext first",
        };
      }
      const promptText = this.options.promptRenderer.render(
        opts.prompt,
        this.cachedContext,
      );
      const result = await this.options.agentRegistry
        .resolve(opts.tool)
        .run({
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
          ...(opts.timeoutMs !== undefined
            ? { timeoutMs: opts.timeoutMs }
            : {}),
          ...(this.signal !== undefined ? { signal: this.signal } : {}),
        });
      if (result.kind === "succeeded") {
        return { kind: "succeeded", stdout: result.stdout };
      }
      if (result.kind === "rate_limited") {
        return { kind: "rate_limited", toolName: result.agentName };
      }
      const errorSummary =
        (result.stderr || result.stdout).trim() || "agent execution failed";
      return { kind: "failed", errorSummary };
    },
  };

  readonly log = {
    write: async (message: string): Promise<void> => {
      await this.options.logStore.write(this.task.taskId, message);
    },
  };

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
