import type { QueueStore } from "../domain/ports/queue-store.js";
import type { QueueTaskInput } from "../domain/queue-task.js";
import type { TaskRecord } from "../domain/task.js";
import { hasStrategy } from "../strategies/index.js";

export interface EnqueueServiceDependencies {
  queueStore: QueueStore;
}

export class EnqueueService {
  constructor(private readonly dependencies: EnqueueServiceDependencies) {}

  async enqueue(input: QueueTaskInput): Promise<TaskRecord> {
    if (!hasStrategy(input.instructionId)) {
      throw new Error(
        `Unknown instructionId '${input.instructionId}' — no strategy is registered.`,
      );
    }

    return this.dependencies.queueStore.enqueue(input);
  }
}
