import type { AgentRunner } from "../infra/agent/agent-runner.js";

export interface AgentRegistryEntry {
  name: string;
  runner: AgentRunner;
}

export class AgentRegistry {
  private readonly runners = new Map<string, AgentRunner>();

  constructor(
    entries: AgentRegistryEntry[],
    private readonly defaultAgentName: string,
  ) {
    for (const entry of entries) {
      this.runners.set(entry.name, entry.runner);
    }

    if (!this.runners.has(defaultAgentName)) {
      throw new Error(
        `DEFAULT_AGENT '${defaultAgentName}' is not in the AGENTS registry`,
      );
    }
  }

  resolve(name: string): AgentRunner {
    const runner = this.runners.get(name);

    if (runner === undefined) {
      throw new Error(`Unknown agent: ${name}`);
    }

    return runner;
  }

  has(name: string): boolean {
    return this.runners.has(name);
  }

  getDefaultAgent(): string {
    return this.defaultAgentName;
  }

  listAgents(): string[] {
    return [...this.runners.keys()];
  }
}

export function normalizeAgentName(name: string): string {
  return name.toUpperCase().replace(/-/g, "_");
}

export interface AgentCommandConfig {
  command: string;
  args: string[];
}

export interface AgentEnvConfig {
  agents: string[];
  defaultAgent: string;
  commands: Record<string, AgentCommandConfig>;
}

export function loadAgentConfigFromEnv(
  env: NodeJS.ProcessEnv,
): AgentEnvConfig {
  const agentsEnv = env.AGENTS;

  if (agentsEnv === undefined || agentsEnv.length === 0) {
    throw new Error("Missing required environment variable: AGENTS");
  }

  const agents = agentsEnv
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (agents.length === 0) {
    throw new Error("AGENTS must contain at least one agent name");
  }

  const defaultAgentEnv = env.DEFAULT_AGENT;
  const defaultAgent =
    defaultAgentEnv !== undefined && defaultAgentEnv.length > 0
      ? defaultAgentEnv
      : (agents[0] as string);

  if (!agents.includes(defaultAgent)) {
    throw new Error(
      `DEFAULT_AGENT '${defaultAgent}' must be one of AGENTS (${agents.join(", ")})`,
    );
  }

  const commands: Record<string, AgentCommandConfig> = {};

  for (const name of agents) {
    const prefix = normalizeAgentName(name);
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

  return { agents, defaultAgent, commands };
}
