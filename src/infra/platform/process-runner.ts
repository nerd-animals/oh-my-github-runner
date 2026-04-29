import { spawn } from "node:child_process";
import type {
  ProcessRunner,
  RunProcessInput,
  RunProcessResult,
} from "../../domain/ports/process-runner.js";

const DEFAULT_KILL_GRACE_PERIOD_MS = 5_000;

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
      let killTimeout: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });

      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      const cleanup = () => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        if (killTimeout !== undefined) {
          clearTimeout(killTimeout);
        }
        if (onAbort !== undefined) {
          input.signal?.removeEventListener("abort", onAbort);
        }
      };

      child.on("error", (error) => {
        cleanup();
        reject(error);
      });

      child.on("close", (code) => {
        cleanup();
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

      if (input.signal !== undefined) {
        const grace = input.killGracePeriodMs ?? DEFAULT_KILL_GRACE_PERIOD_MS;
        onAbort = () => {
          // Try graceful first; on Windows SIGTERM behaves like SIGKILL,
          // but the grace-period escalation below is still a no-op
          // safety net rather than incorrect behavior.
          child.kill("SIGTERM");
          killTimeout = setTimeout(() => {
            child.kill("SIGKILL");
          }, grace);
        };
        if (input.signal.aborted) {
          onAbort();
        } else {
          input.signal.addEventListener("abort", onAbort, { once: true });
        }
      }
    });
  }
}
