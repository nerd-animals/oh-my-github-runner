import type { ToolRunInput, ToolRunResult } from "../../domain/tool.js";
import type { ToolRateLimitConfig } from "./tool-rate-limit-config.js";
import type { ToolRunner } from "../../domain/ports/tool-runner.js";

export interface RateLimitDetectingToolRunnerOptions {
  inner: ToolRunner;
  toolName: string;
  config: ToolRateLimitConfig;
}

export class RateLimitDetectingToolRunner implements ToolRunner {
  constructor(private readonly options: RateLimitDetectingToolRunnerOptions) {}

  async run(input: ToolRunInput): Promise<ToolRunResult> {
    const result = await this.options.inner.run(input);

    if (result.kind !== "failed") {
      return result;
    }

    const signal = this.matchingSignal(result);

    if (signal !== null) {
      return {
        kind: "rate_limited",
        toolName: this.options.toolName,
        signal,
      };
    }

    return result;
  }

  private matchingSignal(
    result: ToolRunResult & { kind: "failed" },
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
