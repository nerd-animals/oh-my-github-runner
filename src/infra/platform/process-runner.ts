import { spawn } from "node:child_process";

export interface RunProcessInput {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
}

export interface RunProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  run(input: RunProcessInput): Promise<RunProcessResult>;
}

export class ChildProcessRunner implements ProcessRunner {
  async run(input: RunProcessInput): Promise<RunProcessResult> {
    return new Promise<RunProcessResult>((resolve, reject) => {
      const child = spawn(input.command, input.args ?? [], {
        cwd: input.cwd,
        env: input.env,
        stdio: "pipe",
      });

      let stdout = "";
      let stderr = "";
      let timeout: NodeJS.Timeout | undefined;

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });

      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("error", (error) => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }

        reject(error);
      });

      child.on("close", (code) => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }

        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
      });

      if (input.stdin !== undefined) {
        child.stdin.write(input.stdin);
      }

      child.stdin.end();

      if (input.timeoutMs !== undefined && input.timeoutMs > 0) {
        timeout = setTimeout(() => {
          child.kill();
        }, input.timeoutMs);
      }
    });
  }
}
