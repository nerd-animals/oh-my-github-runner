import { selectNextTasks as selectNextTasksRule } from "../domain/rules/scheduling.js";
import type { TaskRecord } from "../domain/task.js";

export interface SchedulerServiceOptions {
  maxConcurrency: number;
}

export interface SelectNextTasksInput {
  tasks: TaskRecord[];
  pausedTools?: ReadonlySet<string>;
  toolsForTask: (task: TaskRecord) => readonly string[];
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
