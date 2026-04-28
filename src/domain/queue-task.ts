import type {
  RepoRef,
  SourceRef,
  StickyCommentRef,
  TaskPriority,
  TaskRecord,
} from "./task.js";

export interface QueueTaskInput {
  taskId?: string;
  repo: RepoRef;
  source: SourceRef;
  instructionId: string;
  agent: string;
  additionalInstructions?: string;
  requestedBy: string;
  priority?: TaskPriority;
  stickyComment?: StickyCommentRef;
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
