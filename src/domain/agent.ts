import type { InstructionDefinition } from "./instruction.js";
import type { TaskRecord } from "./task.js";

export interface AgentRunInput {
  task: TaskRecord;
  instruction: InstructionDefinition;
  workspacePath: string;
  prompt: string;
  installationToken?: string;
}

export interface AgentRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
