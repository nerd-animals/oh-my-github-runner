import type { InstructionDefinition } from "../domain/instruction.js";
import type { GitHubSourceContext } from "../domain/github.js";
import type { TaskRecord } from "../domain/task.js";
import type { GitHubClient } from "../domain/ports/github-client.js";
import type { LogStore } from "../domain/ports/log-store.js";
import type { QueueStore } from "../domain/ports/queue-store.js";
import type { WorkspaceManager } from "../domain/ports/workspace-manager.js";
import { ExecutionPromptBuilder } from "../domain/rules/execution-prompt.js";
import { isObserveResultSuperseded } from "../domain/rules/stale-supersede.js";
import {
  buildBranchName,
  buildCommitMessage,
  buildPullRequestTitle,
  withInstructionFooter,
} from "../domain/rules/task-naming.js";
import type { AgentRegistry } from "./agent-registry.js";
import { GitHubResultWriter } from "./execution/github-result-writer.js";

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
    const installationToken =
      await this.dependencies.githubClient.getInstallationAccessToken(
        input.task.repo,
      );
    const workspace =
      await this.dependencies.workspaceManager.preparePrImplementWorkspace(
        input.task.repo,
        input.task,
        headRef,
        installationToken,
      );

    try {
      const agentResult = await this.dependencies.agentRegistry
        .resolve(input.task.agent)
        .run({
          task: input.task,
          instruction: input.instruction,
          workspacePath: workspace.workspacePath,
          installationToken,
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
          withInstructionFooter(
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
        buildCommitMessage(input.task),
      );

      try {
        const prImplementToken =
          await this.dependencies.githubClient.getInstallationAccessToken(
            input.task.repo,
          );
        await this.dependencies.workspaceManager.pushBranch(workspace, {
          installationToken: prImplementToken,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "git push failed";
        await this.dependencies.githubClient.postPullRequestComment(
          input.task.repo,
          input.task.source.number,
          withInstructionFooter(
            `Failed to push commits to \`${headRef}\`: ${message}`,
            input.instruction,
          ),
        );
        return this.fail(input.task.taskId, message);
      }

      await this.dependencies.githubClient.postPullRequestComment(
        input.task.repo,
        input.task.source.number,
        withInstructionFooter(
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
    const installationToken =
      await this.dependencies.githubClient.getInstallationAccessToken(
        input.task.repo,
      );
    const workspace = await this.dependencies.workspaceManager.prepareObserveWorkspace(
      input.task,
      context.kind === "pull_request" ? context.headRef : undefined,
      installationToken,
    );

    try {
      const agentResult = await this.dependencies.agentRegistry
        .resolve(input.task.agent)
        .run({
          task: input.task,
          instruction: input.instruction,
          workspacePath: workspace.workspacePath,
          installationToken,
          prompt: this.promptBuilder.build({
            task: input.task,
            instruction: input.instruction,
            context,
          }),
        });

      if (agentResult.exitCode !== 0) {
        return this.fail(input.task.taskId, agentResult.stderr || agentResult.stdout);
      }

      const body = withInstructionFooter(
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

      const dirty =
        await this.dependencies.workspaceManager.hasChanges(workspace);

      if (dirty) {
        await this.dependencies.logStore.write(
          input.task.taskId,
          "WARN: observe agent left workspace modifications; observe-mode policy violated",
        );
      }

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
    const branchName = buildBranchName(input.task);
    const installationToken =
      await this.dependencies.githubClient.getInstallationAccessToken(
        input.task.repo,
      );
    const workspace =
      await this.dependencies.workspaceManager.prepareMutateWorkspace(
        input.task.repo,
        input.task,
        baseBranch,
        branchName,
        installationToken,
      );

    try {
      const agentResult = await this.dependencies.agentRegistry
        .resolve(input.task.agent)
        .run({
          task: input.task,
          instruction: input.instruction,
          workspacePath: workspace.workspacePath,
          installationToken,
          prompt: this.promptBuilder.build({
            task: input.task,
            instruction: input.instruction,
            context,
          }),
        });

      if (agentResult.exitCode !== 0) {
        const summary = (agentResult.stderr || agentResult.stdout).trim();
        await this.postSourceComment(
          input,
          withInstructionFooter(
            `Ran \`/claude implement\`: agent exited with code ${agentResult.exitCode}.\n\n${truncate(summary, 1500)}`,
            input.instruction,
          ),
        );
        return this.fail(input.task.taskId, summary);
      }

      const hasChanges =
        await this.dependencies.workspaceManager.hasChanges(workspace);

      if (!hasChanges) {
        await this.postSourceComment(
          input,
          withInstructionFooter(
            "Ran `/claude implement`: no changes were needed.",
            input.instruction,
          ),
        );
        await this.dependencies.logStore.write(
          input.task.taskId,
          "mutate completed with no changes",
        );
        return { status: "succeeded" };
      }

      try {
        await this.dependencies.workspaceManager.commitAll(
          workspace,
          buildCommitMessage(input.task),
        );
        const mutateToken =
          await this.dependencies.githubClient.getInstallationAccessToken(
            input.task.repo,
          );
        await this.dependencies.workspaceManager.pushBranch(workspace, {
          installationToken: mutateToken,
        });

        const prBody = withInstructionFooter(
          agentResult.stdout.trim(),
          input.instruction,
        );
        const prTitle = buildPullRequestTitle(input.task);
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
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "mutate publish failed";
        await this.postSourceComment(
          input,
          withInstructionFooter(
            `Ran \`/claude implement\`: failed to publish result.\n\n${truncate(message, 1500)}`,
            input.instruction,
          ),
        );
        return this.fail(input.task.taskId, message);
      }
    } finally {
      await this.dependencies.workspaceManager.cleanupWorkspace(workspace);
    }
  }

  private async postSourceComment(
    input: ExecuteTaskInput,
    body: string,
  ): Promise<void> {
    try {
      if (input.task.source.kind === "issue") {
        await this.dependencies.githubClient.postIssueComment(
          input.task.repo,
          input.task.source.number,
          body,
        );
      } else {
        await this.dependencies.githubClient.postPullRequestComment(
          input.task.repo,
          input.task.source.number,
          body,
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      await this.dependencies.logStore.write(
        input.task.taskId,
        `failed to post fallback comment: ${message}`,
      );
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
}

function truncate(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength)}\n…(truncated, original ${trimmed.length} bytes)`;
}
