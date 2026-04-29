import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
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
import { createClaudeProjectsCleaner } from "./infra/agent/claude-projects-cleaner.js";
import { RateLimitDetectingAgentRunner } from "./infra/agent/rate-limit-detecting-agent-runner.js";
import { loadAgentRateLimitConfig } from "./infra/agent/agent-rate-limit-config.js";
import { buildClaudeToolArgs } from "./infra/agent/agent-tool-policies.js";
import { GitWorkspaceManager } from "./infra/workspaces/git-workspace-manager.js";
import { GitHubAppClient } from "./infra/github/github-app-client.js";
import { loadPromptAssets } from "./infra/prompts/prompt-asset-loader.js";
import {
  AgentRegistry,
  loadAgentConfigFromEnv,
} from "./services/agent-registry.js";
import { DeliveryDedupCache } from "./infra/webhook/delivery-dedup.js";
import { createWebhookServer } from "./infra/webhook/webhook-server.js";
import { RateLimitStateStore } from "./infra/queue/rate-limit-state-store.js";
import {
  renderFailure,
  renderRateLimited,
  renderSuccess,
} from "./services/sticky-comment.js";
import type { TaskRecord } from "./domain/task.js";

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

function parseSenderIdAllowlist(name: string): Set<number> {
  const raw = requireEnv(name);
  const ids = new Set<number>();

  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;

    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `${name} contains a non-integer or non-positive entry: '${trimmed}'`,
      );
    }
    ids.add(parsed);
  }

  if (ids.size === 0) {
    throw new Error(`${name} must list at least one sender id`);
  }

  return ids;
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
  const queueRetentionMs =
    parsePositiveInt(process.env.RUNNER_QUEUE_RETENTION_DAYS, 7) *
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
  const workspacesDir = path.join(runnerRoot, "var", "workspaces");
  const claudeHome =
    process.env.CLAUDE_HOME ?? path.join(os.homedir(), ".claude");
  const cleanupAgentArtifacts = createClaudeProjectsCleaner({
    workspacesDir,
    claudeHome,
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
    workspacesDir,
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
        ...(name === "claude" ? { modeArgsBuilder: buildClaudeToolArgs } : {}),
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

  const promptAssets = await loadPromptAssets({
    promptsDir: path.join(runnerRoot, "definitions", "prompts"),
  });

  const daemon = new RunnerDaemon({
    queueStore,
    instructionLoader,
    schedulerService: new SchedulerService({ maxConcurrency }),
    executionService: new ExecutionService({
      githubClient,
      workspaceManager,
      agentRegistry,
      logStore,
      promptAssets,
      cleanupAgentArtifacts,
    }),
    logStore,
    pollIntervalMs,
    rateLimitStateStore,
    rateLimitCooldownMs,
    retentionMs: queueRetentionMs,
    registeredAgents: agentConfig.agents,
    notifyTaskFailure: async (task, errorSummary) => {
      const body = renderFailure(task, errorSummary);
      await editStickyOrPost(task, body);
    },
    notifyTaskSucceeded: async (task) => {
      if (task.stickyComment === undefined) {
        return;
      }
      await editSticky(task, renderSuccess(task));
    },
    notifyTaskRateLimited: async (task) => {
      if (task.stickyComment === undefined) {
        return;
      }
      await editSticky(task, renderRateLimited(task));
    },
  });

  async function editSticky(task: TaskRecord, body: string): Promise<void> {
    if (task.stickyComment === undefined) {
      return;
    }

    try {
      await githubClient.updateIssueComment(
        task.stickyComment.repo,
        task.stickyComment.commentId,
        body,
      );
    } catch (error) {
      console.warn(
        `[daemon] failed to edit sticky comment for task=${task.taskId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async function editStickyOrPost(
    task: TaskRecord,
    body: string,
  ): Promise<void> {
    if (task.stickyComment !== undefined) {
      await editSticky(task, body);
      return;
    }

    try {
      if (task.source.kind === "issue") {
        await githubClient.postIssueComment(
          task.repo,
          task.source.number,
          body,
        );
      } else {
        await githubClient.postPullRequestComment(
          task.repo,
          task.source.number,
          body,
        );
      }
    } catch (error) {
      console.warn(
        `[daemon] failed to post failure comment for task=${task.taskId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

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

  const allowedSenderIds = parseSenderIdAllowlist("ALLOWED_SENDER_IDS");

  const dispatcher = new EventDispatcher({
    agentRegistry,
    botUserId,
    allowedSenderIds,
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
