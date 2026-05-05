import type { TaskRecord } from "./task.js";

// Tool-agnostic performance dial. Each runner translates this into
// its own model + reasoning-effort pair via a constructor-injected
// preset map; the strategy layer never sees model strings or
// per-tool effort enums.
export type Intensity = "low" | "medium" | "high";

export interface ToolRunInput {
  task: TaskRecord;
  workspacePath: string;
  prompt: string;
  installationToken?: string;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  timeoutMs?: number;
  /**
   * Performance dial. When omitted the runner falls back to its
   * `medium` preset so behavior is deterministic regardless of CLI
   * defaults.
   */
  intensity?: Intensity;
  /**
   * Optional JSON Schema describing the structured final output the
   * model must produce. Runners that natively support structured output
   * (codex) translate this into their CLI flags and return the
   * schema-conformant JSON in `succeeded.stdout`. Runners that do not
   * support it MUST throw rather than silently ignore the option.
   */
  outputSchema?: object;
  /**
   * If aborted, the runner should kill its child process (SIGTERM with a
   * brief grace period before SIGKILL) and return a failed result.
   */
  signal?: AbortSignal;
}

export type ToolRunResult =
  | { kind: "succeeded"; stdout: string }
  | { kind: "failed"; exitCode: number; stdout: string; stderr: string }
  | { kind: "rate_limited"; toolName: string; signal: string };
