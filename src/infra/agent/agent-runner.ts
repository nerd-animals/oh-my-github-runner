import type { AgentRunInput, AgentRunResult } from "../../domain/agent.js";

export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
