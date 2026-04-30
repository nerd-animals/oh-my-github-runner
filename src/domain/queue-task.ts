import type {
  RepoRef,
  SourceRef,
  TaskNotifications,
  TaskPriority,
  TaskRecord,
} from "./task.js";

export interface QueueTaskInput {
  taskId?: string;
  repo: RepoRef;
  source: SourceRef;
  instructionId: string;
  additionalInstructions?: string;
  requestedBy: string;
  priority?: TaskPriority;
  notifications?: TaskNotifications;
}

export function hasSameSource(
  left: Pick<TaskRecord, "repo" | "source">,
  right: Pick<TaskRecord, "repo" | "source">,
): boolean {
  return (
    left.repo.owner === right.repo.owner &&
    left.repo.name === right.repo.name &&
    left.source.kind === right.source.kind &&
    left.source.number === right.source.number
  );
}
