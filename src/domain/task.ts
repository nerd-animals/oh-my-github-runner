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

export interface StickyCommentRef {
  repo: RepoRef;
  issueNumber: number;
  commentId: number;
}

export type TriggerTarget =
  | { kind: "issue"; issueNumber: number }
  | { kind: "comment"; commentId: number };

export interface TriggerReactionRef {
  target: TriggerTarget;
  reactionId: number;
}

export interface TaskNotifications {
  sticky?: StickyCommentRef;
  trigger?: TriggerReactionRef;
}

export interface TaskRecord {
  taskId: string;
  repo: RepoRef;
  source: SourceRef;
  instructionId: string;
  /** Snapshot of the strategy's `policies.tool` at enqueue. Strategies must not read this — toolkit routes ai.run. */
  tool: string;
  additionalInstructions?: string;
  status: TaskStatus;
  priority: TaskPriority;
  requestedBy: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  errorSummary?: string;
  /** Set when status === "superseded" to point at the replacing task. */
  supersededBy?: string;
  notifications?: TaskNotifications;
}
