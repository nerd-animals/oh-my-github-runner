import { pathToFileURL } from "node:url";
import path from "node:path";
import { RunnerDaemon } from "./daemon/runner-daemon.js";
import { Runtime } from "./runtime.js";
import { FileInstructionLoader } from "./infra/instructions/instruction-loader.js";
import { FileQueueStore } from "./infra/queue/file-queue-store.js";
import { FileLogStore } from "./infra/logs/file-log-store.js";
import { SchedulerService } from "./services/scheduler-service.js";
import { ExecutionService } from "./services/execution-service.js";
import { EnqueueService } from "./services/enqueue-service.js";
import { EventDispatcher } from "./services/event-dispatcher.js";
import { WebhookHandler } from "./services/webhook-handler.js";
import { ChildProcessRunner } from "./infra/platform/process-runner.js";
import { HeadlessCommandAgentRunner } from "./infra/agent/headless-command-agent-runner.js";
import { RateLimitDetectingAgentRunner } from "./infra/agent/rate-limit-detecting-agent-runner.js";
import { loadAgentRateLimitConfig } from "./infra/agent/agent-rate-limit-config.js";
import { GitWorkspaceManager } from "./infra/workspaces/git-workspace-manager.js";
import { GitHubAppClient } from "./infra/github/github-app-client.js";
import {
  AgentRegistry,
  loadAgentConfigFromEnv,
} from "./services/agent-registry.js";
import { DeliveryDedupCache } from "./infra/webhook/delivery-dedup.js";
import { createWebhookServer } from "./infra/webhook/webhook-server.js";
import { RateLimitStateStore } from "./infra/queue/rate-limit-state-store.js";

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

export async function buildRuntimeFromEnvironment(): Promise<Runtime> {
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
  const webhookPort = parsePositiveInt(process.env.WEBHOOK_PORT, 8080);
  const webhookHost = process.env.WEBHOOK_HOST ?? "127.0.0.1";

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
  const agentDefinitionsDir = path.join(
    runnerRoot,
    "definitions",
    "agents",
  );
  const agentEntries = await Promise.all(
    agentConfig.agents.map(async (name) => {
      const rateLimitConfig = await loadAgentRateLimitConfig(
        agentDefinitionsDir,
        name,
      );
      const inner = new HeadlessCommandAgentRunner({
        command: agentConfig.commands[name]!.command,
        args: agentConfig.commands[name]!.args,
        processRunner,
      });

      return {
        name,
        runner: new RateLimitDetectingAgentRunner({
          inner,
          agentName: name,
          config: rateLimitConfig,
        }),
      };
    }),
  );
  const agentRegistry = new AgentRegistry(agentEntries, agentConfig.defaultAgent);

  const rateLimitStateStore = new RateLimitStateStore({
    filePath: path.join(runnerRoot, "var", "queue", "state.json"),
  });
  const rateLimitCooldownMs = parsePositiveInt(
    process.env.RATE_LIMIT_COOLDOWN_MS,
    60 * 60 * 1000,
  );

  const queueStore = new FileQueueStore({
    dataDir: path.join(runnerRoot, "var", "queue"),
  });
  const instructionLoader = new FileInstructionLoader(
    path.join(runnerRoot, "definitions", "instructions"),
  );

  const daemon = new RunnerDaemon({
    queueStore,
    instructionLoader,
    schedulerService: new SchedulerService({ maxConcurrency }),
    executionService: new ExecutionService({
      githubClient,
      workspaceManager,
      agentRegistry,
      queueStore,
      logStore,
    }),
    logStore,
    pollIntervalMs,
    rateLimitStateStore,
    rateLimitCooldownMs,
    registeredAgents: agentConfig.agents,
  });

  const enqueueService = new EnqueueService({
    instructionLoader,
    queueStore,
  });

  const botUserIdOverride = process.env.BOT_USER_ID;
  const botUserId =
    botUserIdOverride !== undefined && botUserIdOverride.length > 0
      ? Number(botUserIdOverride)
      : (await githubClient.getAppBotInfo()).id;

  if (!Number.isInteger(botUserId)) {
    throw new Error(`Invalid bot user id: ${botUserId}`);
  }

  const dispatcher = new EventDispatcher({
    agentRegistry,
    botUserId,
  });

  const webhookHandler = new WebhookHandler({
    secret: requireEnv("GITHUB_WEBHOOK_SECRET"),
    dispatcher,
    enqueueService,
    githubClient,
    deliveryDedup: new DeliveryDedupCache(),
  });

  const httpServer = createWebhookServer({ handler: webhookHandler });

  return new Runtime({
    daemon,
    webhookServer: {
      start: () =>
        new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => {
            httpServer.removeListener("listening", onListening);
            reject(error);
          };
          const onListening = () => {
            httpServer.removeListener("error", onError);
            resolve();
          };
          httpServer.once("error", onError);
          httpServer.once("listening", onListening);
          httpServer.listen(webhookPort, webhookHost);
        }),
      stop: () =>
        new Promise<void>((resolve, reject) => {
          httpServer.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    },
  });
}

export async function main(): Promise<void> {
  const abortController = new AbortController();
  process.on("SIGINT", () => abortController.abort());
  process.on("SIGTERM", () => abortController.abort());

  const runtime = await buildRuntimeFromEnvironment();
  await runtime.run(abortController.signal);
}

if (process.argv[1] !== undefined) {
  const currentFileUrl = pathToFileURL(process.argv[1]).href;

  if (import.meta.url === currentFileUrl) {
    void main();
  }
}
