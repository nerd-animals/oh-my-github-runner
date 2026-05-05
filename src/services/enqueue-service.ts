import type { QueueStore } from "../domain/ports/queue-store.js";
import type { QueueTaskInput } from "../domain/queue-task.js";
import type { TaskRecord } from "../domain/task.js";
import { getStrategy, hasStrategy } from "../strategies/index.js";

export interface EnqueueServiceDependencies {
  queueStore: QueueStore;
  /**
   * Optional hook fired for each queued conflict on the same source.
   * Defaults to plain `markSuperseded`. Production wires the daemon so
   * the same call also fires the `onSuperseded` notification (e.g.
   * sticky-comment update). Running tasks are never passed here —
   * supersede is queued-only and an in-flight task runs to completion.
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
      const conflicts = await this.dependencies.queueStore.findQueuedBySource(
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
