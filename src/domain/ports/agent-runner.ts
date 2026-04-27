import type { AgentRunInput, AgentRunResult } from "../agent.js";

export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
