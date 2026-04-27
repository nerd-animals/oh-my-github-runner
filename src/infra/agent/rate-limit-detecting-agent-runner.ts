import type { AgentRunInput, AgentRunResult } from "../../domain/agent.js";
import type { AgentRateLimitConfig } from "./agent-rate-limit-config.js";
import type { AgentRunner } from "../../domain/ports/agent-runner.js";

export class RateLimitedError extends Error {
  constructor(public readonly agentName: string) {
    super(`Agent '${agentName}' is rate-limited`);
    this.name = "RateLimitedError";
  }
}

export interface RateLimitDetectingAgentRunnerOptions {
  inner: AgentRunner;
  agentName: string;
  config: AgentRateLimitConfig;
}

export class RateLimitDetectingAgentRunner implements AgentRunner {
  constructor(private readonly options: RateLimitDetectingAgentRunnerOptions) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const result = await this.options.inner.run(input);

    if (this.matchesRateLimit(result)) {
      throw new RateLimitedError(this.options.agentName);
    }

    return result;
  }

  private matchesRateLimit(result: AgentRunResult): boolean {
    if (this.options.config.exitCodes.includes(result.exitCode)) {
      return true;
    }

    const haystack = `${result.stdout}\n${result.stderr}`;
    return this.options.config.stderrPatterns.some((pattern) =>
      pattern.test(haystack),
    );
  }
}
