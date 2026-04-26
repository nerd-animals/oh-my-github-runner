import type { InstructionDefinition, InstructionLoader } from "../domain/instruction.js";
import type { TaskRecord } from "../domain/task.js";
import { RateLimitedError } from "../infra/agent/rate-limit-detecting-agent-runner.js";
import type { LogStore } from "../infra/logs/log-store.js";
import type { QueueStore } from "../infra/queue/queue-store.js";
import type { RateLimitStateStore } from "../infra/queue/rate-limit-state-store.js";
import type { ExecuteTaskResult, ExecutionService } from "../services/execution-service.js";
import type { SchedulerService } from "../services/scheduler-service.js";

export interface RunnerDaemonDependencies {
  queueStore: QueueStore;
  instructionLoader: InstructionLoader;
  schedulerService: SchedulerService;
  executionService: Pick<ExecutionService, "execute">;
  logStore: LogStore;
  pollIntervalMs: number;
  rateLimitStateStore?: Pick<RateLimitStateStore, "loadActivePauses" | "pause">;
  rateLimitCooldownMs?: number;
  registeredAgents?: readonly string[];
  idleWarningIntervalMs?: number;
  now?: () => number;
  warn?: (message: string) => void;
}

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;
const DEFAULT_IDLE_WARNING_INTERVAL_MS = 60 * 1000;

export class RunnerDaemon {
  private readonly activeTasks = new Map<string, Promise<void>>();
  private readonly rateLimitCooldownMs: number;
  private readonly idleWarningIntervalMs: number;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private lastIdleWarningAt = 0;

  constructor(private readonly dependencies: RunnerDaemonDependencies) {
    this.rateLimitCooldownMs =
      dependencies.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    this.idleWarningIntervalMs =
      dependencies.idleWarningIntervalMs ?? DEFAULT_IDLE_WARNING_INTERVAL_MS;
    this.now = dependencies.now ?? (() => Date.now());
    this.warn = dependencies.warn ?? ((message) => console.warn(message));
  }

  async initialize(): Promise<void> {
    await this.dependencies.queueStore.recoverRunningTasks(
      "daemon interrupted before completion",
    );
    await this.dependencies.logStore.cleanupExpired();
  }

  async tick(): Promise<void> {
    const tasks = await this.dependencies.queueStore.listTasks();
    const instructionsById = await this.loadInstructions(tasks);
    const pausedAgents = await this.loadPausedAgents();
    const nextTaskIds = this.dependencies.schedulerService.selectNextTasks({
      tasks,
      instructionsById,
      pausedAgents,
    });

    if (nextTaskIds.length === 0) {
      this.maybeWarnAllAgentsPaused(tasks, pausedAgents);
    }

    for (const taskId of nextTaskIds) {
      const task = tasks.find((candidate) => candidate.taskId === taskId);

      if (task === undefined) {
        continue;
      }

      const instruction = instructionsById[task.instructionId];

      if (instruction === undefined) {
        continue;
      }

      const startedTask = await this.dependencies.queueStore.startTask(
        task.taskId,
        instruction.revision,
      );

      console.log(
        `[daemon] start task=${task.taskId} instruction=${instruction.id} agent=${task.agent} repo=${task.repo.owner}/${task.repo.name} ${task.source.kind}=${task.source.number}`,
      );

      const activeTask = this.runTask(startedTask, instruction).finally(() => {
        this.activeTasks.delete(task.taskId);
      });

      this.activeTasks.set(task.taskId, activeTask);
    }
  }

  async waitForIdle(): Promise<void> {
    await Promise.all(this.activeTasks.values());
  }

  async start(signal?: AbortSignal): Promise<void> {
    await this.initialize();

    while (signal?.aborted !== true) {
      await this.tick();
      await this.sleep(this.dependencies.pollIntervalMs, signal);
    }

    await this.waitForIdle();
  }

  private async loadPausedAgents(): Promise<ReadonlySet<string>> {
    if (this.dependencies.rateLimitStateStore === undefined) {
      return new Set();
    }

    const active = await this.dependencies.rateLimitStateStore.loadActivePauses();
    return new Set(active.keys());
  }

  private maybeWarnAllAgentsPaused(
    tasks: TaskRecord[],
    pausedAgents: ReadonlySet<string>,
  ): void {
    const registered = this.dependencies.registeredAgents ?? [];

    if (registered.length === 0) {
      return;
    }

    if (!registered.every((agent) => pausedAgents.has(agent))) {
      return;
    }

    if (!tasks.some((task) => task.status === "queued")) {
      return;
    }

    const now = this.now();

    if (now - this.lastIdleWarningAt < this.idleWarningIntervalMs) {
      return;
    }

    this.lastIdleWarningAt = now;
    this.warn(
      `All registered agents are rate-limited (${registered.join(", ")}); queued tasks are blocked until pauses expire.`,
    );
  }

  private async runTask(
    task: TaskRecord,
    instruction: InstructionDefinition,
  ): Promise<void> {
    let result: ExecuteTaskResult;

    try {
      result = await this.dependencies.executionService.execute({
        task,
        instruction,
      });
    } catch (error) {
      if (error instanceof RateLimitedError) {
        await this.handleRateLimit(task, error);
        return;
      }

      result = {
        status: "failed",
        errorSummary:
          error instanceof Error ? error.message : "unexpected daemon error",
      };
    }

    if (result.status === "succeeded") {
      console.log(`[daemon] succeed task=${task.taskId}`);
    } else {
      console.error(
        `[daemon] fail task=${task.taskId} error=${result.errorSummary ?? "unknown"}`,
      );
    }

    await this.dependencies.queueStore.completeTask(task.taskId, result);
  }

  private async handleRateLimit(
    task: TaskRecord,
    error: RateLimitedError,
  ): Promise<void> {
    await this.dependencies.queueStore.revertToQueued(task.taskId);

    if (this.dependencies.rateLimitStateStore !== undefined) {
      const pausedUntil = this.now() + this.rateLimitCooldownMs;
      await this.dependencies.rateLimitStateStore.pause(
        error.agentName,
        pausedUntil,
      );
      console.warn(
        `[daemon] rate-limited task=${task.taskId} agent=${error.agentName} pausedUntil=${new Date(pausedUntil).toISOString()}`,
      );
      await this.dependencies.logStore.write(
        task.taskId,
        `rate-limited; paused agent '${error.agentName}' until ${new Date(pausedUntil).toISOString()}`,
      );
    } else {
      console.warn(
        `[daemon] rate-limited task=${task.taskId} agent=${error.agentName} (no state store)`,
      );
      await this.dependencies.logStore.write(
        task.taskId,
        `rate-limited; reverted to queued (no state store configured)`,
      );
    }
  }

  private async loadInstructions(
    tasks: TaskRecord[],
  ): Promise<Record<string, InstructionDefinition>> {
    const instructionIds = [...new Set(tasks.map((task) => task.instructionId))];
    const entries = await Promise.all(
      instructionIds.map(async (instructionId) => [
        instructionId,
        await this.dependencies.instructionLoader.loadById(instructionId),
      ] as const),
    );

    return Object.fromEntries(entries);
  }

  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0 || signal?.aborted === true) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timeout);
        resolve();
      };

      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
