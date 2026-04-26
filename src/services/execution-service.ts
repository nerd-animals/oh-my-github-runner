import type { InstructionDefinition } from "../domain/instruction.js";
import type { GitHubSourceContext } from "../domain/github.js";
import type { TaskRecord } from "../domain/task.js";
import type { GitHubClient } from "../infra/github/github-client.js";
import type { LogStore } from "../infra/logs/log-store.js";
import type { QueueStore } from "../infra/queue/queue-store.js";
import type { WorkspaceManager } from "../infra/workspaces/workspace-manager.js";
import type { AgentRegistry } from "./agent-registry.js";
import { ExecutionPromptBuilder } from "./execution/execution-prompt-builder.js";
import { GitHubResultWriter } from "./execution/github-result-writer.js";
import { isObserveResultSuperseded } from "./stale-supersede.js";

export interface ExecutionServiceDependencies {
  githubClient: GitHubClient;
  workspaceManager: WorkspaceManager;
  agentRegistry: Pick<AgentRegistry, "resolve">;
  queueStore: Pick<QueueStore, "listTasks">;
  logStore: LogStore;
}

export interface ExecuteTaskInput {
  task: TaskRecord;
  instruction: InstructionDefinition;
}

export interface ExecuteTaskResult {
  status: "succeeded" | "failed";
  errorSummary?: string;
}

export class ExecutionService {
  private readonly promptBuilder = new ExecutionPromptBuilder();
  private readonly resultWriter: GitHubResultWriter;

  constructor(private readonly dependencies: ExecutionServiceDependencies) {
    this.resultWriter = new GitHubResultWriter({
      githubClient: dependencies.githubClient,
    });
  }

  async execute(input: ExecuteTaskInput): Promise<ExecuteTaskResult> {
    await this.dependencies.logStore.write(
      input.task.taskId,
      `starting ${input.instruction.id}`,
    );

    const context = await this.dependencies.githubClient.getSourceContext(
      input.task.repo,
      input.task.source,
      input.instruction.context,
    );

    if (input.instruction.id === "pr-implement") {
      if (context.kind !== "pull_request") {
        return this.fail(
          input.task.taskId,
          "pr-implement requires a pull_request source",
        );
      }

      return this.executePrImplement(input, context);
    }

    if (input.instruction.mode === "observe") {
      return this.executeObserve(input, context);
    }

    return this.executeMutate(input, context);
  }

  private async executePrImplement(
    input: ExecuteTaskInput,
    context: GitHubSourceContext & { kind: "pull_request" },
  ): Promise<ExecuteTaskResult> {
    const headRef = context.headRef;
    const workspace =
      await this.dependencies.workspaceManager.preparePrImplementWorkspace(
        input.task.repo,
        input.task,
        headRef,
      );

    try {
      const agentResult = await this.dependencies.agentRegistry
        .resolve(input.task.agent)
        .run({
          task: input.task,
          instruction: input.instruction,
          workspacePath: workspace.workspacePath,
          prompt: this.promptBuilder.build({
            task: input.task,
            instruction: input.instruction,
            context,
          }),
        });

      if (agentResult.exitCode !== 0) {
        return this.fail(
          input.task.taskId,
          agentResult.stderr || agentResult.stdout,
        );
      }

      const hasChanges =
        await this.dependencies.workspaceManager.hasChanges(workspace);

      if (!hasChanges) {
        await this.dependencies.githubClient.postPullRequestComment(
          input.task.repo,
          input.task.source.number,
          this.withInstructionFooter(
            "Ran `/claude implement`: no changes were needed.",
            input.instruction,
          ),
        );
        await this.dependencies.logStore.write(
          input.task.taskId,
          "pr-implement completed with no changes",
        );
        return { status: "succeeded" };
      }

      await this.dependencies.workspaceManager.commitAll(
        workspace,
        this.buildCommitMessage(input.task),
      );

      try {
        await this.dependencies.workspaceManager.pushBranch(workspace);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "git push failed";
        await this.dependencies.githubClient.postPullRequestComment(
          input.task.repo,
          input.task.source.number,
          this.withInstructionFooter(
            `Failed to push commits to \`${headRef}\`: ${message}`,
            input.instruction,
          ),
        );
        return this.fail(input.task.taskId, message);
      }

      await this.dependencies.githubClient.postPullRequestComment(
        input.task.repo,
        input.task.source.number,
        this.withInstructionFooter(
          `Pushed commits to \`${headRef}\`.\n\n${agentResult.stdout.trim()}`,
          input.instruction,
        ),
      );

      await this.dependencies.logStore.write(
        input.task.taskId,
        `pr-implement pushed commits to ${headRef}`,
      );
      return { status: "succeeded" };
    } finally {
      await this.dependencies.workspaceManager.cleanupWorkspace(workspace);
    }
  }

  private async executeObserve(
    input: ExecuteTaskInput,
    context: GitHubSourceContext,
  ): Promise<ExecuteTaskResult> {
    const workspace = await this.dependencies.workspaceManager.prepareObserveWorkspace(
      input.task,
      context.kind === "pull_request" ? context.headRef : undefined,
    );

    try {
      const agentResult = await this.dependencies.agentRegistry
        .resolve(input.task.agent)
        .run({
          task: input.task,
          instruction: input.instruction,
          workspacePath: workspace.workspacePath,
          prompt: this.promptBuilder.build({
            task: input.task,
            instruction: input.instruction,
            context,
          }),
        });

      if (agentResult.exitCode !== 0) {
        return this.fail(input.task.taskId, agentResult.stderr || agentResult.stdout);
      }

      const body = this.withInstructionFooter(
        agentResult.stdout.trim(),
        input.instruction,
      );

      const otherTasks = await this.dependencies.queueStore.listTasks();

      if (isObserveResultSuperseded(input.task, otherTasks)) {
        await this.dependencies.logStore.write(
          input.task.taskId,
          "observe write-back skipped: superseded by newer task",
        );
        return { status: "succeeded" };
      }

      await this.resultWriter.writeObserveResult({
        task: input.task,
        instruction: input.instruction,
        body,
      });

      await this.dependencies.logStore.write(input.task.taskId, "observe completed");
      return { status: "succeeded" };
    } finally {
      await this.dependencies.workspaceManager.cleanupWorkspace(workspace);
    }
  }

  private async executeMutate(
    input: ExecuteTaskInput,
    context: GitHubSourceContext,
  ): Promise<ExecuteTaskResult> {
    const baseBranch =
      context.kind === "pull_request"
        ? context.baseRef
        : await this.dependencies.githubClient.getDefaultBranch(input.task.repo);
    const branchName = this.buildBranchName(input.task);
    const workspace =
      await this.dependencies.workspaceManager.prepareMutateWorkspace(
        input.task.repo,
        input.task,
        baseBranch,
        branchName,
      );

    try {
      const agentResult = await this.dependencies.agentRegistry
        .resolve(input.task.agent)
        .run({
          task: input.task,
          instruction: input.instruction,
          workspacePath: workspace.workspacePath,
          prompt: this.promptBuilder.build({
            task: input.task,
            instruction: input.instruction,
            context,
          }),
        });

      if (agentResult.exitCode !== 0) {
        return this.fail(input.task.taskId, agentResult.stderr || agentResult.stdout);
      }

      const hasChanges =
        await this.dependencies.workspaceManager.hasChanges(workspace);

      if (!hasChanges) {
        await this.dependencies.logStore.write(
          input.task.taskId,
          "mutate completed with no changes",
        );
        return { status: "succeeded" };
      }

      await this.dependencies.workspaceManager.commitAll(
        workspace,
        this.buildCommitMessage(input.task),
      );
      await this.dependencies.workspaceManager.pushBranch(workspace);

      const prBody = this.withInstructionFooter(
        agentResult.stdout.trim(),
        input.instruction,
      );
      const prTitle = this.buildPullRequestTitle(input.task);
      const pullRequest = await this.resultWriter.writeMutateResult({
        task: input.task,
        instruction: input.instruction,
        baseBranch,
        branchName: workspace.branchName,
        title: prTitle,
        body: prBody,
      });

      await this.dependencies.logStore.write(
        input.task.taskId,
        `mutate completed with PR ${pullRequest.url}`,
      );
      return { status: "succeeded" };
    } finally {
      await this.dependencies.workspaceManager.cleanupWorkspace(workspace);
    }
  }

  private async fail(taskId: string, rawError: string): Promise<ExecuteTaskResult> {
    const errorSummary = rawError.trim() || "agent execution failed";
    await this.dependencies.logStore.write(taskId, `failed: ${errorSummary}`);
    return {
      status: "failed",
      errorSummary,
    };
  }

  private withInstructionFooter(
    body: string,
    instruction: InstructionDefinition,
  ): string {
    const trimmedBody = body.length > 0 ? body : "No summary provided.";
    return `${trimmedBody}\n\n_Instruction: ${instruction.id} r${instruction.revision}_`;
  }

  private buildBranchName(task: TaskRecord): string {
    return `ai/${task.source.kind}-${task.source.number}`;
  }

  private buildCommitMessage(task: TaskRecord): string {
    return `feat: address ${task.source.kind} #${task.source.number}`;
  }

  private buildPullRequestTitle(task: TaskRecord): string {
    if (task.source.kind === "issue") {
      return `Resolve issue #${task.source.number}`;
    }

    return `Follow up for PR #${task.source.number}`;
  }
}
