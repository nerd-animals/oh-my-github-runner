import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

export interface ToolRateLimitConfig {
  exitCodes: number[];
  stderrPatterns: RegExp[];
}

interface RawToolRateLimitConfig {
  exit_codes?: number[];
  stderr_patterns?: string[];
}

const EMPTY_CONFIG: ToolRateLimitConfig = {
  exitCodes: [],
  stderrPatterns: [],
};

export async function loadToolRateLimitConfig(
  definitionsDir: string,
  toolName: string,
): Promise<ToolRateLimitConfig> {
  const filePath = path.resolve(definitionsDir, `${toolName}.yaml`);

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

  const parsed = (parse(raw) ?? {}) as RawToolRateLimitConfig;

  return {
    exitCodes: Array.isArray(parsed.exit_codes) ? [...parsed.exit_codes] : [],
    stderrPatterns: Array.isArray(parsed.stderr_patterns)
      ? parsed.stderr_patterns.map((pattern) => new RegExp(pattern))
      : [],
  };
}
