import type { LogStore } from "../domain/ports/log-store.js";
import type { QueueStore } from "../domain/ports/queue-store.js";
import type { TaskRecord } from "../domain/task.js";
import type { RateLimitStateStore } from "../infra/queue/rate-limit-state-store.js";
import type { SchedulerService } from "../services/scheduler-service.js";
import type { ExecuteResult } from "../strategies/types.js";

export interface RunnerDaemonDependencies {
  queueStore: QueueStore;
  schedulerService: SchedulerService;
  // Runs a task to completion. The daemon owns when to call this; the
  // composition root supplies the implementation (typically `getStrategy(...)
  // .run(task, toolkitFactory.create(task), signal)`). Tests inject a stub.
  runStrategy: (
    task: TaskRecord,
    signal: AbortSignal,
  ) => Promise<ExecuteResult>;
  logStore: LogStore;
  pollIntervalMs: number;
  rateLimitStateStore?: Pick<RateLimitStateStore, "loadActivePauses" | "pause">;
  rateLimitCooldownMs?: number;
  registeredAgents?: readonly string[];
  idleWarningIntervalMs?: number;
  retentionMs?: number;
  pruneIntervalMs?: number;
  now?: () => number;
  warn?: (message: string) => void;
  notifyTaskFailure?: (
    task: TaskRecord,
    errorSummary: string,
  ) => Promise<void>;
  notifyTaskSucceeded?: (task: TaskRecord) => Promise<void>;
  notifyTaskRateLimited?: (task: TaskRecord) => Promise<void>;
}

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;
const DEFAULT_IDLE_WARNING_INTERVAL_MS = 60 * 1000;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class RunnerDaemon {
  private readonly activeTasks = new Map<string, Promise<void>>();
  private readonly rateLimitCooldownMs: number;
  private readonly idleWarningIntervalMs: number;
  private readonly retentionMs: number;
  private readonly pruneIntervalMs: number;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private lastIdleWarningAt = 0;
  private lastPruneAt = 0;

  constructor(private readonly dependencies: RunnerDaemonDependencies) {
    this.rateLimitCooldownMs =
      dependencies.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    this.idleWarningIntervalMs =
      dependencies.idleWarningIntervalMs ?? DEFAULT_IDLE_WARNING_INTERVAL_MS;
    this.retentionMs = dependencies.retentionMs ?? DEFAULT_RETENTION_MS;
    this.pruneIntervalMs =
      dependencies.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    this.now = dependencies.now ?? (() => Date.now());
    this.warn = dependencies.warn ?? ((message) => console.warn(message));
  }

  async initialize(): Promise<void> {
    await this.dependencies.queueStore.recoverRunningTasks(
      "daemon interrupted before completion",
    );
    await this.dependencies.logStore.cleanupExpired();
    await this.maybePrune(true);
  }

  async tick(): Promise<void> {
    await this.maybePrune(false);
    const tasks = await this.dependencies.queueStore.listTasks();
    const pausedAgents = await this.loadPausedAgents();
    const nextTaskIds = this.dependencies.schedulerService.selectNextTasks({
      tasks,
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

      const startedTask = await this.dependencies.queueStore.startTask(
        task.taskId,
      );

      console.log(
        `[daemon] start task=${task.taskId} instruction=${task.instructionId} agent=${task.agent} repo=${task.repo.owner}/${task.repo.name} ${task.source.kind}=${task.source.number}`,
      );

      const activeTask = this.runTask(startedTask).finally(() => {
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

  private async maybePrune(force: boolean): Promise<void> {
    const now = this.now();
    if (!force && now - this.lastPruneAt < this.pruneIntervalMs) {
      return;
    }
    this.lastPruneAt = now;
    try {
      const cutoff = new Date(now - this.retentionMs);
      const pruned =
        await this.dependencies.queueStore.pruneTerminalTasks(cutoff);
      if (pruned > 0) {
        console.log(
          `[daemon] pruned ${pruned} terminal task file(s) older than ${cutoff.toISOString()}`,
        );
      }
    } catch (error) {
      this.warn(
        `[daemon] pruneTerminalTasks threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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

  private async runTask(task: TaskRecord): Promise<void> {
    // Per-task AbortController. PR C will plumb this through supersede so
    // a newer trigger on the same source can cancel an in-flight run; for
    // now it stays unused (no aborts are issued).
    const ctrl = new AbortController();
    let result: ExecuteResult;

    try {
      result = await this.dependencies.runStrategy(task, ctrl.signal);
    } catch (error) {
      result = {
        status: "failed",
        errorSummary:
          error instanceof Error ? error.message : "unexpected daemon error",
      };
    }

    if (result.status === "rate_limited") {
      await this.handleRateLimit(task, result.agentName);
      return;
    }

    if (result.status === "succeeded") {
      console.log(`[daemon] succeed task=${task.taskId}`);

      if (this.dependencies.notifyTaskSucceeded !== undefined) {
        try {
          await this.dependencies.notifyTaskSucceeded(task);
        } catch (error) {
          this.warn(
            `[daemon] notifyTaskSucceeded threw: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } else {
      console.error(
        `[daemon] fail task=${task.taskId} error=${result.errorSummary}`,
      );

      if (this.dependencies.notifyTaskFailure !== undefined) {
        try {
          await this.dependencies.notifyTaskFailure(
            task,
            result.errorSummary,
          );
        } catch (error) {
          this.warn(
            `[daemon] notifyTaskFailure threw: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    await this.dependencies.queueStore.completeTask(task.taskId, result);
  }

  private async handleRateLimit(
    task: TaskRecord,
    agentName: string,
  ): Promise<void> {
    await this.dependencies.queueStore.revertToQueued(task.taskId);

    if (this.dependencies.notifyTaskRateLimited !== undefined) {
      try {
        await this.dependencies.notifyTaskRateLimited(task);
      } catch (error) {
        this.warn(
          `[daemon] notifyTaskRateLimited threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (this.dependencies.rateLimitStateStore !== undefined) {
      const pausedUntil = this.now() + this.rateLimitCooldownMs;
      await this.dependencies.rateLimitStateStore.pause(
        agentName,
        pausedUntil,
      );
      console.warn(
        `[daemon] rate-limited task=${task.taskId} agent=${agentName} pausedUntil=${new Date(pausedUntil).toISOString()}`,
      );
      await this.dependencies.logStore.write(
        task.taskId,
        `rate-limited; paused agent '${agentName}' until ${new Date(pausedUntil).toISOString()}`,
      );
    } else {
      console.warn(
        `[daemon] rate-limited task=${task.taskId} agent=${agentName} (no state store)`,
      );
      await this.dependencies.logStore.write(
        task.taskId,
        `rate-limited; reverted to queued (no state store configured)`,
      );
    }
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
