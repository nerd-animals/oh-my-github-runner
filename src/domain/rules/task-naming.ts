import type { TaskRecord } from "../task.js";

export function buildBranchName(task: TaskRecord): string {
  return `ai/${task.source.kind}-${task.source.number}`;
}
