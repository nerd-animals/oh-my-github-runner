import type { InstructionLoader } from "../domain/instruction.js";
import type { QueueTaskInput } from "../domain/queue-task.js";
import type { TaskRecord } from "../domain/task.js";
import type { QueueStore } from "../infra/queue/queue-store.js";
import type { RepoAllowlist } from "./repo-allowlist.js";

export interface EnqueueServiceDependencies {
  instructionLoader: InstructionLoader;
  queueStore: QueueStore;
  repoAllowlist: Pick<RepoAllowlist, "isAllowed">;
}

export class EnqueueService {
  constructor(private readonly dependencies: EnqueueServiceDependencies) {}

  async enqueue(input: QueueTaskInput): Promise<TaskRecord> {
    if (!this.dependencies.repoAllowlist.isAllowed(input.repo)) {
      throw new Error(
        `Repository ${input.repo.owner}/${input.repo.name} is not in the allowlist`,
      );
    }

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
