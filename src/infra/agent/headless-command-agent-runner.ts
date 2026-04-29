import type { AgentRunInput, AgentRunResult } from "../../domain/agent.js";
import type { AgentRunner } from "../../domain/ports/agent-runner.js";
import type { ProcessRunner } from "../../domain/ports/process-runner.js";

export interface HeadlessCommandAgentRunnerOptions {
  command: string;
  args?: string[];
  processRunner: ProcessRunner;
  extraEnv?: NodeJS.ProcessEnv;
}

export class HeadlessCommandAgentRunner implements AgentRunner {
  constructor(private readonly options: HeadlessCommandAgentRunnerOptions) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const baseArgs = this.options.args ?? [];
    const toolArgs: string[] = [];

    if (input.allowedTools !== undefined && input.allowedTools.length > 0) {
      toolArgs.push("--allowed-tools", input.allowedTools.join(" "));
    }
    if (input.disallowedTools !== undefined && input.disallowedTools.length > 0) {
      toolArgs.push("--disallowed-tools", input.disallowedTools.join(" "));
    }

    const result = await this.options.processRunner.run({
      command: this.options.command,
      args: [...baseArgs, ...toolArgs],
      cwd: input.workspacePath,
      stdin: input.prompt,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      env: {
        ...process.env,
        ...this.options.extraEnv,
        RUNNER_TASK_ID: input.task.taskId,
        RUNNER_INSTRUCTION_ID: input.task.instructionId,
        RUNNER_REPO_OWNER: input.task.repo.owner,
        RUNNER_REPO_NAME: input.task.repo.name,
        ...(input.installationToken !== undefined
          ? {
              GH_TOKEN: input.installationToken,
              GITHUB_TOKEN: input.installationToken,
            }
          : {}),
      },
    });

    if (result.exitCode === 0) {
      return { kind: "succeeded", stdout: result.stdout };
    }

    return {
      kind: "failed",
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}
