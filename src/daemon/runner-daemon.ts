import type { InstructionDefinition, InstructionLoader } from "../domain/instruction.js";
import type { TaskRecord } from "../domain/task.js";
import type { LogStore } from "../infra/logs/log-store.js";
import type { QueueStore } from "../infra/queue/queue-store.js";
import type { ExecuteTaskResult, ExecutionService } from "../services/execution-service.js";
import type { SchedulerService } from "../services/scheduler-service.js";

export interface RunnerDaemonDependencies {
  queueStore: QueueStore;
  instructionLoader: InstructionLoader;
  schedulerService: SchedulerService;
  executionService: Pick<ExecutionService, "execute">;
  logStore: LogStore;
  pollIntervalMs: number;
}

export class RunnerDaemon {
  private readonly activeTasks = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: RunnerDaemonDependencies) {}

  async initialize(): Promise<void> {
    await this.dependencies.queueStore.recoverRunningTasks(
      "daemon interrupted before completion",
    );
    await this.dependencies.logStore.cleanupExpired();
  }

  async tick(): Promise<void> {
    const tasks = await this.dependencies.queueStore.listTasks();
    const instructionsById = await this.loadInstructions(tasks);
    const nextTaskIds = this.dependencies.schedulerService.selectNextTasks({
      tasks,
      instructionsById,
    });

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
      result = {
        status: "failed",
        errorSummary:
          error instanceof Error ? error.message : "unexpected daemon error",
      };
    }

    await this.dependencies.queueStore.completeTask(task.taskId, result);
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
