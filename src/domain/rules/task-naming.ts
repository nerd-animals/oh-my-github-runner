import type { TaskRecord } from "../task.js";

export function buildBranchName(task: TaskRecord): string {
  // Append a short task-id suffix so concurrent runs against the same
  // (source-kind, number) cannot collide on a branch name. The suffix is
  // the tail of the task id, which already includes a random component.
  const suffix = task.taskId.slice(-8);
  return `ai/${task.source.kind}-${task.source.number}-${suffix}`;
}
