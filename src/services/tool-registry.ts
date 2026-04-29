import type { ToolRunner } from "../domain/ports/tool-runner.js";

export interface ToolRegistryEntry {
  name: string;
  runner: ToolRunner;
}

export class ToolRegistry {
  private readonly runners = new Map<string, ToolRunner>();

  constructor(
    entries: ToolRegistryEntry[],
    private readonly defaultToolName: string,
  ) {
    for (const entry of entries) {
      this.runners.set(entry.name, entry.runner);
    }

    if (!this.runners.has(defaultToolName)) {
      throw new Error(
        `DEFAULT_AGENT '${defaultToolName}' is not in the AGENTS registry`,
      );
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

  getDefaultTool(): string {
    return this.defaultToolName;
  }

  listTools(): string[] {
    return [...this.runners.keys()];
  }
}

export function normalizeToolName(name: string): string {
  return name.toUpperCase().replace(/-/g, "_");
}

export interface ToolCommandConfig {
  command: string;
  args: string[];
}

export interface ToolEnvConfig {
  tools: string[];
  defaultTool: string;
  commands: Record<string, ToolCommandConfig>;
}

// NB: env-var names (AGENTS / DEFAULT_AGENT / <NAME>_COMMAND / <NAME>_ARGS_JSON)
// are intentionally NOT renamed in this commit — that's an operator-visible
// change and stays as a separate follow-up so existing deploys don't break.
export function loadToolConfigFromEnv(
  env: NodeJS.ProcessEnv,
): ToolEnvConfig {
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

  const defaultToolEnv = env.DEFAULT_AGENT;
  const defaultTool =
    defaultToolEnv !== undefined && defaultToolEnv.length > 0
      ? defaultToolEnv
      : (tools[0] as string);

  if (!tools.includes(defaultTool)) {
    throw new Error(
      `DEFAULT_AGENT '${defaultTool}' must be one of AGENTS (${tools.join(", ")})`,
    );
  }

  const commands: Record<string, ToolCommandConfig> = {};

  for (const name of tools) {
    const prefix = normalizeToolName(name);
    const commandKey = `${prefix}_COMMAND`;
    const command = env[commandKey];

    if (command === undefined || command.length === 0) {
      throw new Error(`Missing required environment variable: ${commandKey}`);
    }

    const argsJsonKey = `${prefix}_ARGS_JSON`;
    const argsJson = env[argsJsonKey];
    const args =
      argsJson === undefined || argsJson.length === 0
        ? []
        : (JSON.parse(argsJson) as string[]);

    commands[name] = { command, args };
  }

  return { tools, defaultTool, commands };
}
