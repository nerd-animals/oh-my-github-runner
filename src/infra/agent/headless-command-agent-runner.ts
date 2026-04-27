import type { AgentRunInput, AgentRunResult } from "../../domain/agent.js";
import type { ExecutionMode } from "../../domain/instruction.js";
import type { AgentRunner } from "../../domain/ports/agent-runner.js";
import type { ProcessRunner } from "../../domain/ports/process-runner.js";

export interface HeadlessCommandAgentRunnerOptions {
  command: string;
  args?: string[];
  processRunner: ProcessRunner;
  extraEnv?: NodeJS.ProcessEnv;
  modeArgsBuilder?: (mode: ExecutionMode) => string[];
}

export class HeadlessCommandAgentRunner implements AgentRunner {
  constructor(private readonly options: HeadlessCommandAgentRunnerOptions) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const baseArgs = this.options.args ?? [];
    const modeArgs =
      this.options.modeArgsBuilder !== undefined
        ? this.options.modeArgsBuilder(input.instruction.mode)
        : [];

    const result = await this.options.processRunner.run({
      command: this.options.command,
      args: [...baseArgs, ...modeArgs],
      cwd: input.workspacePath,
      stdin: input.prompt,
      timeoutMs: input.instruction.execution.timeoutSec * 1000,
      env: {
        ...process.env,
        ...this.options.extraEnv,
        RUNNER_TASK_ID: input.task.taskId,
        RUNNER_MODE: input.instruction.mode,
        RUNNER_INSTRUCTION_ID: input.instruction.id,
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

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}
