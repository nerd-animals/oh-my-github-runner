import type { AgentRunInput, AgentRunResult } from "../../domain/agent.js";
import type { AgentRateLimitConfig } from "./agent-rate-limit-config.js";
import type { AgentRunner } from "../../domain/ports/agent-runner.js";

export interface RateLimitDetectingAgentRunnerOptions {
  inner: AgentRunner;
  agentName: string;
  config: AgentRateLimitConfig;
}

export class RateLimitDetectingAgentRunner implements AgentRunner {
  constructor(private readonly options: RateLimitDetectingAgentRunnerOptions) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const result = await this.options.inner.run(input);

    if (result.kind !== "failed") {
      return result;
    }

    const signal = this.matchingSignal(result);

    if (signal !== null) {
      return {
        kind: "rate_limited",
        agentName: this.options.agentName,
        signal,
      };
    }

    return result;
  }

  private matchingSignal(
    result: AgentRunResult & { kind: "failed" },
  ): string | null {
    if (this.options.config.exitCodes.includes(result.exitCode)) {
      return `exit_code=${result.exitCode}`;
    }

    const haystack = `${result.stdout}\n${result.stderr}`;
    for (const pattern of this.options.config.stderrPatterns) {
      if (pattern.test(haystack)) {
        return `pattern=${pattern.source}`;
      }
    }

    return null;
  }
}
