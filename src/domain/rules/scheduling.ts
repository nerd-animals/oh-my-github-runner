import type { TaskRecord } from "../task.js";

export interface SelectNextTasksInput {
  tasks: TaskRecord[];
  maxConcurrency: number;
  pausedAgents?: ReadonlySet<string>;
}

// Pure FIFO scheduling against the concurrency budget, skipping any
// queued task whose agent is rate-limit-paused. Same-repo mutate
// serialization is no longer needed: branch names now include a
// taskId suffix so concurrent mutate runs cannot collide on a branch,
// and same-source duplicate triggers are handled by supersede-on-enqueue
// rather than by holding back the second task in the scheduler.
export function selectNextTasks(input: SelectNextTasksInput): string[] {
  const pausedAgents = input.pausedAgents ?? new Set<string>();
  const runningCount = input.tasks.filter(
    (task) => task.status === "running",
  ).length;
  const slots = input.maxConcurrency - runningCount;

  if (slots <= 0) {
    return [];
  }

  const selected: string[] = [];
  for (const task of input.tasks.filter((t) => t.status === "queued")) {
    if (selected.length >= slots) {
      break;
    }
    if (pausedAgents.has(task.tool)) {
      continue;
    }
    selected.push(task.taskId);
  }
  return selected;
}
