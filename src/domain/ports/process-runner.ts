export interface RunProcessInput {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  /** Abort signal: SIGTERM the child, SIGKILL after `killGracePeriodMs`. */
  signal?: AbortSignal;
  killGracePeriodMs?: number;
}

export interface RunProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  run(input: RunProcessInput): Promise<RunProcessResult>;
}
