import type { InstructionDefinition } from "./instruction.js";
import type { TaskRecord } from "./task.js";

export interface AgentRunInput {
  task: TaskRecord;
  instruction: InstructionDefinition;
  workspacePath: string;
  prompt: string;
  installationToken?: string;
}

export type AgentRunResult =
  | { kind: "succeeded"; stdout: string }
  | { kind: "failed"; exitCode: number; stdout: string; stderr: string }
  | { kind: "rate_limited"; agentName: string; signal: string };
