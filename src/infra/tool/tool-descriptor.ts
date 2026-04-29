import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

export interface ToolRateLimitConfig {
  exitCodes: number[];
  stderrPatterns: RegExp[];
}

export interface ToolDescriptor {
  args: readonly string[];
  rateLimit: ToolRateLimitConfig;
}

interface RawToolDescriptor {
  args?: unknown;
  exit_codes?: number[];
  stderr_patterns?: string[];
}

const EMPTY_DESCRIPTOR: ToolDescriptor = {
  args: [],
  rateLimit: { exitCodes: [], stderrPatterns: [] },
};

export async function loadToolDescriptor(
  definitionsDir: string,
  toolName: string,
): Promise<ToolDescriptor> {
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
      return EMPTY_DESCRIPTOR;
    }

    throw error;
  }

  const parsed = (parse(raw) ?? {}) as RawToolDescriptor;

  return {
    args: Array.isArray(parsed.args)
      ? parsed.args.map((value) => String(value))
      : [],
    rateLimit: {
      exitCodes: Array.isArray(parsed.exit_codes) ? [...parsed.exit_codes] : [],
      stderrPatterns: Array.isArray(parsed.stderr_patterns)
        ? parsed.stderr_patterns.map((pattern) => new RegExp(pattern))
        : [],
    },
  };
}
