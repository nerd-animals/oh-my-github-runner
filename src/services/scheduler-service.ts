import type { InstructionDefinition } from "../domain/instruction.js";
import {
  selectNextTasks as selectNextTasksRule,
} from "../domain/rules/scheduling.js";
import type { TaskRecord } from "../domain/task.js";

export interface SchedulerServiceOptions {
  maxConcurrency: number;
}

export interface SelectNextTasksInput {
  tasks: TaskRecord[];
  instructionsById: Record<string, InstructionDefinition>;
  pausedAgents?: ReadonlySet<string>;
}

export class SchedulerService {
  constructor(private readonly options: SchedulerServiceOptions) {}

  selectNextTasks(input: SelectNextTasksInput): string[] {
    return selectNextTasksRule({
      ...input,
      maxConcurrency: this.options.maxConcurrency,
    });
  }
}
