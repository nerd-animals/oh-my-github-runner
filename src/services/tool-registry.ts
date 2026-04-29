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

/** All tools this build knows about. Adding a new tool here is the source
 *  of truth; the operator activates one by setting `<NAME>_COMMAND` in env. */
export const KNOWN_TOOLS = ["claude"] as const;

export interface ToolEnvConfig {
  tools: string[];
  /** Per-tool binary path (the deploy-specific bit). The argv list comes from
   *  the tool's yaml descriptor under `definitions/tools/`, not env. */
  commands: Record<string, string>;
}

export function loadToolConfigFromEnv(env: NodeJS.ProcessEnv): ToolEnvConfig {
  const tools: string[] = [];
  const commands: Record<string, string> = {};

  for (const name of KNOWN_TOOLS) {
    const command = env[`${normalizeToolName(name)}_COMMAND`];
    if (command !== undefined && command.length > 0) {
      tools.push(name);
      commands[name] = command;
    }
  }

  if (tools.length === 0) {
    throw new Error(
      `No tool enabled — set at least one <NAME>_COMMAND env var (known: ${KNOWN_TOOLS.join(
        ", ",
      )})`,
    );
  }

  return { tools, commands };
}
