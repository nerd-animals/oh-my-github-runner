import type { ToolRunner } from "../domain/ports/tool-runner.js";

export interface ToolRegistryEntry {
  name: string;
  runner: ToolRunner;
}

export class ToolRegistry {
  private readonly runners = new Map<string, ToolRunner>();

  constructor(entries: ToolRegistryEntry[]) {
    for (const entry of entries) {
      this.runners.set(entry.name, entry.runner);
    }
  }

  resolve(name: string): ToolRunner {
    const runner = this.runners.get(name);

    if (runner === undefined) {
      throw new Error(`Unknown tool: ${name}`);
    }

    return runner;
  }

  has(name: string): boolean {
    return this.runners.has(name);
  }

  listTools(): string[] {
    return [...this.runners.keys()];
  }
}

export function normalizeToolName(name: string): string {
  return name.toUpperCase().replace(/-/g, "_");
}

export interface ToolEnvConfig {
  tools: string[];
  /** Per-tool binary path (the deploy-specific bit). The argv list comes from
   *  the tool's yaml descriptor under `definitions/tools/`, not env. */
  commands: Record<string, string>;
}

// NB: AGENTS / <NAME>_COMMAND env-var names are still the pre-rename names —
// operator-visible env rename stays as a separate follow-up.
export function loadToolConfigFromEnv(env: NodeJS.ProcessEnv): ToolEnvConfig {
  const toolsEnv = env.AGENTS;

  if (toolsEnv === undefined || toolsEnv.length === 0) {
    throw new Error("Missing required environment variable: AGENTS");
  }

  const tools = toolsEnv
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (tools.length === 0) {
    throw new Error("AGENTS must contain at least one tool name");
  }

  const commands: Record<string, string> = {};

  for (const name of tools) {
    const prefix = normalizeToolName(name);
    const commandKey = `${prefix}_COMMAND`;
    const command = env[commandKey];

    if (command === undefined || command.length === 0) {
      throw new Error(`Missing required environment variable: ${commandKey}`);
    }

    commands[name] = command;
  }

  return { tools, commands };
}
