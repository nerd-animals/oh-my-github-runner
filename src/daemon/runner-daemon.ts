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
  /**
   * Resolves the set of tool names a task may route to. Production wires
   * this to `Object.keys(getStrategy(task.instructionId).policies.uses)`.
   * Tests inject a stub.
   */
  toolsForTask: (task: TaskRecord) => readonly string[];
  logStore: LogStore;
  pollIntervalMs: number;
  rateLimit?: RateLimitDispatch;
  notifications?: TaskNotifications;
  janitor?: JanitorConfig;
  /**
   * Live recovery for tasks stuck in `running/` while the daemon is alive.
   * Boot-time recovery is handled by `QueueStore.recoverRunningTasks` and
   * is independent. Stale = on-disk `running` AND not in `activeTasks` AND
   * `startedAt` older than `cutoffMs`. Recovered tasks are moved to
   * `failed` (not requeued) since side effects like branch pushes or
   * sticky comments may already have happened.
   */
  staleRunning?: StaleRunningConfig;
  clock?: DaemonClock;
}

export interface StaleRunningConfig {
  cutoffMs?: number;
}

export interface RateLimitDispatch {
  store: Pick<RateLimitStateStore, "loadActivePauses" | "pause">;
  cooldownMs?: number;
  registeredTools?: readonly string[];
  idleWarningIntervalMs?: number;
}

export interface TaskNotifications {
  onFailure?: (task: TaskRecord, errorSummary: string) => Promise<void>;
  onSucceeded?: (task: TaskRecord) => Promise<void>;
  onRateLimited?: (task: TaskRecord) => Promise<void>;
  onSuperseded?: (task: TaskRecord, supersededBy: string) => Promise<void>;
}

export interface JanitorConfig {
  /**
   * Optional janitor that runs once at startup. Receives the set of
   * taskIds that are still tracked in the queue (queued + running) and
   * removes any on-disk workspace directories not in that set — i.e.
   * leftover state from a process crash mid-run.
   */
  cleanupOrphanWorkspaces?: (
    activeTaskIds: ReadonlySet<string>,
  ) => Promise<number>;
  retentionMs?: number;
  pruneIntervalMs?: number;
}

export interface DaemonClock {
  now?: () => number;
  warn?: (message: string) => void;
}

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_IDLE_WARNING_INTERVAL_MS = 60 * 1000;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_RUNNING_CUTOFF_MS = 30 * 60 * 1000;

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
  private readonly staleRunningCutoffMs: number;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private lastIdleWarningAt = 0;
  private lastPruneAt = 0;

  constructor(private readonly dependencies: RunnerDaemonDependencies) {
    this.rateLimitCooldownMs =
      dependencies.rateLimit?.cooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    this.idleWarningIntervalMs =
      dependencies.rateLimit?.idleWarningIntervalMs ??
      DEFAULT_IDLE_WARNING_INTERVAL_MS;
    this.retentionMs =
      dependencies.janitor?.retentionMs ?? DEFAULT_RETENTION_MS;
    this.pruneIntervalMs =
      dependencies.janitor?.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    this.staleRunningCutoffMs =
      dependencies.staleRunning?.cutoffMs ?? DEFAULT_STALE_RUNNING_CUTOFF_MS;
    this.now = dependencies.clock?.now ?? (() => Date.now());
    this.warn =
      dependencies.clock?.warn ?? ((message) => console.warn(message));
  }

  async initialize(): Promise<void> {
    await this.dependencies.queueStore.recoverRunningTasks(
      "daemon interrupted before completion",
    );
    const cleanupOrphanWorkspaces =
      this.dependencies.janitor?.cleanupOrphanWorkspaces;
    if (cleanupOrphanWorkspaces !== undefined) {
      try {
        const tasks = await this.dependencies.queueStore.listTasks();
        const active = new Set(
          tasks
            .filter(
              (task) => task.status === "queued" || task.status === "running",
            )
            .map((task) => task.taskId),
        );
        const removed = await cleanupOrphanWorkspaces(active);
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
    await this.sweepStaleRunning(tasks);
    const pausedTools = await this.loadPausedTools();
    const nextTaskIds = this.dependencies.schedulerService.selectNextTasks({
      tasks,
      pausedTools,
      toolsForTask: this.dependencies.toolsForTask,
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

      const tools = this.dependencies.toolsForTask(task).join(",");
      console.log(
        `[daemon] start task=${task.taskId} instruction=${task.instructionId} tools=${tools} repo=${task.repo.owner}/${task.repo.name} ${task.source.kind}=${task.source.number}`,
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

  private async sweepStaleRunning(tasks: TaskRecord[]): Promise<void> {
    const now = this.now();
    const recovered: string[] = [];

    for (const task of tasks) {
      if (task.status !== "running") {
        continue;
      }
      if (this.activeTasks.has(task.taskId)) {
        continue;
      }
      if (task.startedAt === undefined) {
        continue;
      }
      const startedAtMs = Date.parse(task.startedAt);
      if (Number.isNaN(startedAtMs)) {
        continue;
      }
      const ageMs = now - startedAtMs;
      if (ageMs < this.staleRunningCutoffMs) {
        continue;
      }

      const errorSummary = `stale running: no in-memory active task (age=${ageMs}ms, startedAt=${task.startedAt})`;
      try {
        await this.dependencies.queueStore.completeTask(task.taskId, {
          status: "failed",
          errorSummary,
        });
        recovered.push(task.taskId);
        console.warn(
          `[daemon] recovered stale running task=${task.taskId} from=running to=failed startedAt=${task.startedAt} ageMs=${ageMs}`,
        );
      } catch (error) {
        this.warn(
          `[daemon] sweepStaleRunning completeTask failed task=${task.taskId} from=running to=failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (recovered.length > 0) {
      console.warn(
        `[daemon] sweepStaleRunning recovered ${recovered.length} task(s): ${recovered.join(", ")}`,
      );
    }
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
    const store = this.dependencies.rateLimit?.store;
    if (store === undefined) {
      return new Set();
    }

    const active = await store.loadActivePauses();
    return new Set(active.keys());
  }

  private maybeWarnAllToolsPaused(
    tasks: TaskRecord[],
    pausedTools: ReadonlySet<string>,
  ): void {
    const registered = this.dependencies.rateLimit?.registeredTools ?? [];

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
      const onSuperseded = this.dependencies.notifications?.onSuperseded;
      if (onSuperseded !== undefined) {
        try {
          await onSuperseded(task, active.supersededBy);
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

      const onSucceeded = this.dependencies.notifications?.onSucceeded;
      if (onSucceeded !== undefined) {
        try {
          await onSucceeded(task);
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

      const onFailure = this.dependencies.notifications?.onFailure;
      if (onFailure !== undefined) {
        try {
          await onFailure(task, result.errorSummary);
        } catch (error) {
          this.warn(
            `[daemon] notifyTaskFailure threw: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    try {
      await this.dependencies.queueStore.completeTask(task.taskId, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.warn(
        `[daemon] completeTask failed task=${task.taskId} from=running to=${result.status} operation=completeTask: ${message}`,
      );
      try {
        await this.dependencies.logStore.write(
          task.taskId,
          `completeTask failed (running -> ${result.status}): ${message}`,
        );
      } catch {
        // logStore failure is non-fatal; daemon must keep going.
      }
    }
  }

  private async handleRateLimit(
    task: TaskRecord,
    toolName: string,
  ): Promise<void> {
    try {
      await this.dependencies.queueStore.revertToQueued(task.taskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.warn(
        `[daemon] revertToQueued failed task=${task.taskId} from=running to=queued operation=revertToQueued: ${message}`,
      );
      try {
        await this.dependencies.logStore.write(
          task.taskId,
          `revertToQueued failed (running -> queued): ${message}`,
        );
      } catch {
        // logStore failure is non-fatal; daemon must keep going.
      }
    }

    const onRateLimited = this.dependencies.notifications?.onRateLimited;
    if (onRateLimited !== undefined) {
      try {
        await onRateLimited(task);
      } catch (error) {
        this.warn(
          `[daemon] notifyTaskRateLimited threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const store = this.dependencies.rateLimit?.store;
    if (store !== undefined) {
      const pausedUntil = this.now() + this.rateLimitCooldownMs;
      await store.pause(toolName, pausedUntil);
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
