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
