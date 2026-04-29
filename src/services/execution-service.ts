import type { InstructionDefinition } from "../domain/instruction.js";
import type { GitHubSourceContext } from "../domain/github.js";
import type { TaskRecord } from "../domain/task.js";
import type { GitHubClient } from "../domain/ports/github-client.js";
import type { LogStore } from "../domain/ports/log-store.js";
import type { WorkspaceManager } from "../domain/ports/workspace-manager.js";
import { ExecutionPromptBuilder } from "../domain/rules/execution-prompt.js";
import { buildBranchName } from "../domain/rules/task-naming.js";
import type { PromptAssets } from "../infra/prompts/prompt-asset-loader.js";
import type { CleanupAgentArtifacts } from "../domain/ports/agent-artifact-cleaner.js";
import type { AgentRegistry } from "./agent-registry.js";

export interface ExecutionServiceDependencies {
  githubClient: GitHubClient;
  workspaceManager: WorkspaceManager;
  agentRegistry: Pick<AgentRegistry, "resolve">;
  logStore: LogStore;
  promptAssets: PromptAssets;
  cleanupAgentArtifacts: CleanupAgentArtifacts;
}

export interface ExecuteTaskInput {
  task: TaskRecord;
  instruction: InstructionDefinition;
}

export type ExecuteTaskResult =
  | { status: "succeeded" }
  | { status: "failed"; errorSummary: string }
  | { status: "rate_limited"; agentName: string };

export class ExecutionService {
  private readonly promptBuilder: ExecutionPromptBuilder;

  constructor(private readonly dependencies: ExecutionServiceDependencies) {
    this.promptBuilder = new ExecutionPromptBuilder({
      commonRules: dependencies.promptAssets.commonRules,
      personas: dependencies.promptAssets.personas,
      modePolicies: dependencies.promptAssets.modePolicies,
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

    switch (input.instruction.workflow) {
      case "observe":
        return this.executeObserve(input, context);
      case "mutate":
        return this.executeMutate(input, context);
      case "pr_implement":
        if (context.kind !== "pull_request") {
          return this.fail(
            input.task.taskId,
            "pr_implement workflow requires a pull_request source",
          );
        }
        return this.executePrImplement(input, context);
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
    const workspace =
      await this.dependencies.workspaceManager.prepareObserveWorkspace(
        input.task,
        context.kind === "pull_request" ? context.headRef : undefined,
        installationToken,
      );

    try {
      const agentResult = await this.runAgent(input, context, workspace.workspacePath, installationToken);

      if (agentResult.terminal !== "succeeded") {
        return agentResult.result;
      }

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
      await this.dependencies.cleanupAgentArtifacts(workspace.workspacePath);
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
      const agentResult = await this.runAgent(input, context, workspace.workspacePath, installationToken);

      if (agentResult.terminal !== "succeeded") {
        return agentResult.result;
      }

      await this.dependencies.logStore.write(
        input.task.taskId,
        `mutate completed on branch ${workspace.branchName}`,
      );
      return { status: "succeeded" };
    } finally {
      await this.dependencies.workspaceManager.cleanupWorkspace(workspace);
      await this.dependencies.cleanupAgentArtifacts(workspace.workspacePath);
    }
  }

  private async executePrImplement(
    input: ExecuteTaskInput,
    context: GitHubSourceContext & { kind: "pull_request" },
  ): Promise<ExecuteTaskResult> {
    const installationToken =
      await this.dependencies.githubClient.getInstallationAccessToken(
        input.task.repo,
      );
    const workspace =
      await this.dependencies.workspaceManager.preparePrImplementWorkspace(
        input.task.repo,
        input.task,
        context.headRef,
        installationToken,
      );

    try {
      const agentResult = await this.runAgent(input, context, workspace.workspacePath, installationToken);

      if (agentResult.terminal !== "succeeded") {
        return agentResult.result;
      }

      await this.dependencies.logStore.write(
        input.task.taskId,
        `pr-implement completed on ${context.headRef}`,
      );
      return { status: "succeeded" };
    } finally {
      await this.dependencies.workspaceManager.cleanupWorkspace(workspace);
      await this.dependencies.cleanupAgentArtifacts(workspace.workspacePath);
    }
  }

  private async runAgent(
    input: ExecuteTaskInput,
    context: GitHubSourceContext,
    workspacePath: string,
    installationToken: string,
  ): Promise<
    | { terminal: "succeeded" }
    | { terminal: "early"; result: ExecuteTaskResult }
  > {
    const agentResult = await this.dependencies.agentRegistry
      .resolve(input.task.agent)
      .run({
        task: input.task,
        instruction: input.instruction,
        workspacePath,
        installationToken,
        prompt: this.promptBuilder.build({
          task: input.task,
          instruction: input.instruction,
          context,
        }),
      });

    if (agentResult.kind === "rate_limited") {
      return {
        terminal: "early",
        result: { status: "rate_limited", agentName: agentResult.agentName },
      };
    }

    if (agentResult.kind === "failed") {
      return {
        terminal: "early",
        result: await this.fail(
          input.task.taskId,
          agentResult.stderr || agentResult.stdout,
        ),
      };
    }

    return { terminal: "succeeded" };
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
