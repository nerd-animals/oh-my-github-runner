import { pathToFileURL } from "node:url";
import path from "node:path";
import { RunnerDaemon } from "./daemon/runner-daemon.js";
import { FileInstructionLoader } from "./infra/instructions/instruction-loader.js";
import { FileQueueStore } from "./infra/queue/file-queue-store.js";
import { FileLogStore } from "./infra/logs/file-log-store.js";
import { SchedulerService } from "./services/scheduler-service.js";
import { ExecutionService } from "./services/execution-service.js";
import { ChildProcessRunner } from "./infra/platform/process-runner.js";
import { HeadlessCommandAgentRunner } from "./infra/agent/headless-command-agent-runner.js";
import { GitWorkspaceManager } from "./infra/workspaces/git-workspace-manager.js";
import { GitHubAppClient } from "./infra/github/github-app-client.js";
import {
  AgentRegistry,
  loadAgentConfigFromEnv,
} from "./services/agent-registry.js";

function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.length === 0) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function createDaemonFromEnvironment(): RunnerDaemon {
  const runnerRoot = process.env.RUNNER_ROOT ?? process.cwd();
  const pollIntervalMs = parsePositiveInt(
    process.env.RUNNER_POLL_INTERVAL_MS,
    2000,
  );
  const maxConcurrency = parsePositiveInt(
    process.env.RUNNER_MAX_CONCURRENCY,
    2,
  );
  const logRetentionMs =
    parsePositiveInt(process.env.RUNNER_LOG_RETENTION_DAYS, 3) *
    24 *
    60 *
    60 *
    1000;
  const processRunner = new ChildProcessRunner();
  const logStore = new FileLogStore({
    logsDir: path.join(runnerRoot, "var", "logs"),
    retentionMs: logRetentionMs,
  });

  const githubClient = new GitHubAppClient({
    appId: requireEnv("GITHUB_APP_ID"),
    privateKeyPath: requireEnv("GITHUB_APP_PRIVATE_KEY_PATH"),
    ...(process.env.GITHUB_API_BASE_URL !== undefined
      ? { apiBaseUrl: process.env.GITHUB_API_BASE_URL }
      : {}),
  });
  const workspaceManager = new GitWorkspaceManager({
    reposDir: path.join(runnerRoot, "var", "repos"),
    workspacesDir: path.join(runnerRoot, "var", "workspaces"),
    processRunner,
    ...(process.env.GITHUB_WEB_BASE_URL !== undefined
      ? { githubWebBaseUrl: process.env.GITHUB_WEB_BASE_URL }
      : {}),
  });
  const agentConfig = loadAgentConfigFromEnv(process.env);
  const agentRegistry = new AgentRegistry(
    agentConfig.agents.map((name) => ({
      name,
      runner: new HeadlessCommandAgentRunner({
        command: agentConfig.commands[name]!.command,
        args: agentConfig.commands[name]!.args,
        processRunner,
      }),
    })),
    agentConfig.defaultAgent,
  );

  return new RunnerDaemon({
    queueStore: new FileQueueStore({
      dataDir: path.join(runnerRoot, "var", "queue"),
    }),
    instructionLoader: new FileInstructionLoader(
      path.join(runnerRoot, "definitions", "instructions"),
    ),
    schedulerService: new SchedulerService({
      maxConcurrency,
    }),
    executionService: new ExecutionService({
      githubClient,
      workspaceManager,
      agentRegistry,
      logStore,
    }),
    logStore,
    pollIntervalMs,
  });
}

export async function main(): Promise<void> {
  const abortController = new AbortController();
  const daemon = createDaemonFromEnvironment();

  process.on("SIGINT", () => abortController.abort());
  process.on("SIGTERM", () => abortController.abort());

  await daemon.start(abortController.signal);
}

if (process.argv[1] !== undefined) {
  const currentFileUrl = pathToFileURL(process.argv[1]).href;

  if (import.meta.url === currentFileUrl) {
    void main();
  }
}
