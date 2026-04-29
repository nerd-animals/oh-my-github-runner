import type { TaskRecord } from "./task.js";

export interface AgentRunInput {
  task: TaskRecord;
  workspacePath: string;
  prompt: string;
  installationToken?: string;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  timeoutMs?: number;
  /**
   * If aborted, the runner should kill its child process (SIGTERM with a
   * brief grace period before SIGKILL) and return a failed result.
   */
  signal?: AbortSignal;
}

export type AgentRunResult =
  | { kind: "succeeded"; stdout: string }
  | { kind: "failed"; exitCode: number; stdout: string; stderr: string }
  | { kind: "rate_limited"; agentName: string; signal: string };
