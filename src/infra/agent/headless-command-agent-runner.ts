import type { AgentRunInput, AgentRunResult } from "../../domain/agent.js";
import type { AgentRunner } from "./agent-runner.js";
import type { ProcessRunner } from "../platform/process-runner.js";

export interface HeadlessCommandAgentRunnerOptions {
  command: string;
  args?: string[];
  processRunner: ProcessRunner;
  extraEnv?: NodeJS.ProcessEnv;
}

export class HeadlessCommandAgentRunner implements AgentRunner {
  constructor(private readonly options: HeadlessCommandAgentRunnerOptions) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const result = await this.options.processRunner.run({
      command: this.options.command,
      args: this.options.args ?? [],
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
      },
    });

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}
