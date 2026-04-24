import type { InstructionLoader } from "../domain/instruction.js";
import type { QueueTaskInput } from "../domain/queue-task.js";
import type { TaskRecord } from "../domain/task.js";
import type { QueueStore } from "../infra/queue/queue-store.js";

export interface EnqueueServiceDependencies {
  instructionLoader: InstructionLoader;
  queueStore: QueueStore;
}

export class EnqueueService {
  constructor(private readonly dependencies: EnqueueServiceDependencies) {}

  async enqueue(input: QueueTaskInput): Promise<TaskRecord> {
    const instruction = await this.dependencies.instructionLoader.loadById(
      input.instructionId,
    );

    if (instruction.sourceKind !== input.source.kind) {
      throw new Error(
        `Instruction source kind mismatch: expected ${instruction.sourceKind}, received ${input.source.kind}.`,
      );
    }

    return this.dependencies.queueStore.enqueue(input);
  }
}
