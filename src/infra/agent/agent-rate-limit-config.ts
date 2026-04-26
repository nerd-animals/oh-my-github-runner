import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

export interface AgentRateLimitConfig {
  exitCodes: number[];
  stderrPatterns: RegExp[];
}

interface RawAgentRateLimitConfig {
  exit_codes?: number[];
  stderr_patterns?: string[];
}

const EMPTY_CONFIG: AgentRateLimitConfig = {
  exitCodes: [],
  stderrPatterns: [],
};

export async function loadAgentRateLimitConfig(
  definitionsDir: string,
  agentName: string,
): Promise<AgentRateLimitConfig> {
  const filePath = path.resolve(definitionsDir, `${agentName}.yaml`);

  let raw: string;

  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const isMissingFile =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT";

    if (isMissingFile) {
      return EMPTY_CONFIG;
    }

    throw error;
  }

  const parsed = (parse(raw) ?? {}) as RawAgentRateLimitConfig;

  return {
    exitCodes: Array.isArray(parsed.exit_codes) ? [...parsed.exit_codes] : [],
    stderrPatterns: Array.isArray(parsed.stderr_patterns)
      ? parsed.stderr_patterns.map((pattern) => new RegExp(pattern))
      : [],
  };
}
