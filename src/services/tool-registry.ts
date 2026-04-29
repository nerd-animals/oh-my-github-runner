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

export interface ToolEnvConfig {
  tools: string[];
  /** Per-tool binary path (the deploy-specific bit). The argv list comes from
   *  the tool's yaml descriptor under `definitions/tools/`, not env. */
  commands: Record<string, string>;
}

// Each tool has its own `<NAME>_COMMAND` env block below. Adding a new tool
// is "add a block here + add a yaml under definitions/tools/" — no scanning,
// no string-built keys, no list to keep in sync.
export function loadToolConfigFromEnv(env: NodeJS.ProcessEnv): ToolEnvConfig {
  const tools: string[] = [];
  const commands: Record<string, string> = {};

  if (env.CLAUDE_COMMAND !== undefined && env.CLAUDE_COMMAND.length > 0) {
    tools.push("claude");
    commands.claude = env.CLAUDE_COMMAND;
  }

  if (tools.length === 0) {
    throw new Error(
      "No tool enabled — set at least one <NAME>_COMMAND env var (e.g. CLAUDE_COMMAND)",
    );
  }

  return { tools, commands };
}
