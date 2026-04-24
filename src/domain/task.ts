import type { TaskStatus } from "./task-status.js";

export type SourceKind = "issue" | "pull_request";
export type TaskPriority = "normal";

export interface RepoRef {
  owner: string;
  name: string;
}

export interface SourceRef {
  kind: SourceKind;
  number: number;
}

export interface TaskRecord {
  taskId: string;
  repo: RepoRef;
  source: SourceRef;
  instructionId: string;
  instructionRevision?: number;
  status: TaskStatus;
  priority: TaskPriority;
  requestedBy: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  errorSummary?: string;
}
