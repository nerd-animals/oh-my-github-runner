import type { QueueStore } from "../domain/ports/queue-store.js";
import type { QueueTaskInput } from "../domain/queue-task.js";
import type { TaskRecord } from "../domain/task.js";
import { getStrategy, hasStrategy } from "../strategies/index.js";

export interface EnqueueServiceDependencies {
  queueStore: QueueStore;
  /**
   * Optional hook for taking action on a running task being superseded.
   * Defaults to markSuperseded only — the daemon supplies an
   * abort-aware handler in production so a running run gets
   * cancelled in addition to having its record marked.
   */
  onSupersede?: (oldTaskId: string, newTaskId: string) => Promise<void>;
}

export class EnqueueService {
  constructor(private readonly dependencies: EnqueueServiceDependencies) {}

  async enqueue(input: QueueTaskInput): Promise<TaskRecord> {
    if (!hasStrategy(input.instructionId)) {
      throw new Error(
        `Unknown instructionId '${input.instructionId}' — no strategy is registered.`,
      );
    }

    const newStrategy = getStrategy(input.instructionId);
    // Insert the new task first, then sweep prior conflicts. The opposite
    // order would leave a window where the queue is empty for this source.
    const newTask = await this.dependencies.queueStore.enqueue(input);

    if (newStrategy.policies.supersedeOnSameSource) {
      const conflicts = await this.dependencies.queueStore.findActiveBySource(
        input.repo,
        input.source,
      );
      for (const old of conflicts) {
        if (old.taskId === newTask.taskId) {
          continue;
        }
        if (!hasStrategy(old.instructionId)) {
          continue;
        }
        const oldStrategy = getStrategy(old.instructionId);
        if (!oldStrategy.policies.supersedeOnSameSource) {
          continue;
        }
        if (this.dependencies.onSupersede !== undefined) {
          await this.dependencies.onSupersede(old.taskId, newTask.taskId);
        } else {
          await this.dependencies.queueStore.markSuperseded(
            old.taskId,
            newTask.taskId,
          );
        }
      }
    }

    return newTask;
  }
}
