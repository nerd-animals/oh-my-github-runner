import type { RepoRef, SourceRef, TaskPriority, TaskRecord } from "./task.js";

export interface QueueTaskInput {
  repo: RepoRef;
  source: SourceRef;
  instructionId: string;
  agent: string;
  additionalInstructions?: string;
  requestedBy: string;
  priority?: TaskPriority;
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
