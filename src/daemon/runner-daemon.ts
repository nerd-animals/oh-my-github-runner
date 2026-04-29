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
  registeredTools?: readonly string[];
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
  notifyTaskSuperseded?: (
    task: TaskRecord,
    supersededBy: string,
  ) => Promise<void>;
  /**
   * Optional janitor that runs once at startup. Receives the set of
   * taskIds that are still tracked in the queue (queued + running) and
   * removes any on-disk workspace directories not in that set — i.e.
   * leftover state from a process crash mid-run.
   */
  cleanupOrphanWorkspaces?: (
    activeTaskIds: ReadonlySet<string>,
  ) => Promise<number>;
}

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;
const DEFAULT_IDLE_WARNING_INTERVAL_MS = 60 * 1000;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface ActiveTask {
  promise: Promise<void>;
  abort: AbortController;
  /** Task id of the request that superseded this one, if any. */
  supersededBy: string | null;
}

export class RunnerDaemon {
  private readonly activeTasks = new Map<string, ActiveTask>();
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
    if (this.dependencies.cleanupOrphanWorkspaces !== undefined) {
      try {
        const tasks = await this.dependencies.queueStore.listTasks();
        const active = new Set(
          tasks
            .filter(
              (task) => task.status === "queued" || task.status === "running",
            )
            .map((task) => task.taskId),
        );
        const removed = await this.dependencies.cleanupOrphanWorkspaces(active);
        if (removed > 0) {
          console.log(
            `[daemon] cleanupOrphanWorkspaces removed ${removed} orphan workspace dir(s)`,
          );
        }
      } catch (error) {
        this.warn(
          `[daemon] cleanupOrphanWorkspaces threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await this.dependencies.logStore.cleanupExpired();
    await this.maybePrune(true);
  }

  async tick(): Promise<void> {
    await this.maybePrune(false);
    const tasks = await this.dependencies.queueStore.listTasks();
    const pausedTools = await this.loadPausedTools();
    const nextTaskIds = this.dependencies.schedulerService.selectNextTasks({
      tasks,
      pausedTools,
    });

    if (nextTaskIds.length === 0) {
      this.maybeWarnAllToolsPaused(tasks, pausedTools);
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
        `[daemon] start task=${task.taskId} instruction=${task.instructionId} tool=${task.tool} repo=${task.repo.owner}/${task.repo.name} ${task.source.kind}=${task.source.number}`,
      );

      const abort = new AbortController();
      const active: ActiveTask = {
        promise: Promise.resolve(),
        abort,
        supersededBy: null,
      };
      active.promise = this.runTask(startedTask, active).finally(() => {
        this.activeTasks.delete(task.taskId);
      });
      this.activeTasks.set(task.taskId, active);
    }
  }

  /**
   * Supersede a queued- or running-status task. If the task is currently
   * running, its AbortSignal is fired so the strategy can unwind cleanly;
   * the queue record is then moved to "superseded" with `supersededBy` set.
   * No-op if the task isn't active anymore (already completed, etc).
   */
  async supersede(oldTaskId: string, newTaskId: string): Promise<void> {
    const active = this.activeTasks.get(oldTaskId);
    if (active !== undefined) {
      active.supersededBy = newTaskId;
      active.abort.abort();
      // Persist the supersede status now so observers see it immediately;
      // runTask will skip its own completeTask call when supersededBy is set.
      try {
        await this.dependencies.queueStore.markSuperseded(
          oldTaskId,
          newTaskId,
        );
      } catch (error) {
        this.warn(
          `[daemon] markSuperseded(running) threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return;
    }
    // Not running on this daemon — just persist the supersede status.
    try {
      await this.dependencies.queueStore.markSuperseded(oldTaskId, newTaskId);
    } catch (error) {
      this.warn(
        `[daemon] markSuperseded(queued) threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async waitForIdle(): Promise<void> {
    await Promise.all(
      Array.from(this.activeTasks.values()).map((entry) => entry.promise),
    );
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

  private async loadPausedTools(): Promise<ReadonlySet<string>> {
    if (this.dependencies.rateLimitStateStore === undefined) {
      return new Set();
    }

    const active = await this.dependencies.rateLimitStateStore.loadActivePauses();
    return new Set(active.keys());
  }

  private maybeWarnAllToolsPaused(
    tasks: TaskRecord[],
    pausedTools: ReadonlySet<string>,
  ): void {
    const registered = this.dependencies.registeredTools ?? [];

    if (registered.length === 0) {
      return;
    }

    if (!registered.every((tool) => pausedTools.has(tool))) {
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
      `All registered tools are rate-limited (${registered.join(", ")}); queued tasks are blocked until pauses expire.`,
    );
  }

  private async runTask(
    task: TaskRecord,
    active: ActiveTask,
  ): Promise<void> {
    let result: ExecuteResult;

    try {
      result = await this.dependencies.runStrategy(task, active.abort.signal);
    } catch (error) {
      result = {
        status: "failed",
        errorSummary:
          error instanceof Error ? error.message : "unexpected daemon error",
      };
    }

    // If supersede fired while the run was in flight, the queue record
    // has already been moved to "superseded" by daemon.supersede(). Skip
    // completeTask (which expects to find the task in "running") and skip
    // notifyTaskFailure — the strategy crash here is the abort, not a real
    // failure.
    if (active.supersededBy !== null) {
      console.log(
        `[daemon] superseded task=${task.taskId} by=${active.supersededBy}`,
      );
      if (this.dependencies.notifyTaskSuperseded !== undefined) {
        try {
          await this.dependencies.notifyTaskSuperseded(
            task,
            active.supersededBy,
          );
        } catch (error) {
          this.warn(
            `[daemon] notifyTaskSuperseded threw: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      return;
    }

    if (result.status === "rate_limited") {
      await this.handleRateLimit(task, result.toolName);
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
    toolName: string,
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
        toolName,
        pausedUntil,
      );
      console.warn(
        `[daemon] rate-limited task=${task.taskId} tool=${toolName} pausedUntil=${new Date(pausedUntil).toISOString()}`,
      );
      await this.dependencies.logStore.write(
        task.taskId,
        `rate-limited; paused tool '${toolName}' until ${new Date(pausedUntil).toISOString()}`,
      );
    } else {
      console.warn(
        `[daemon] rate-limited task=${task.taskId} tool=${toolName} (no state store)`,
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
