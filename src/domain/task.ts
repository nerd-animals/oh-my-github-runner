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
  /** @deprecated read-only legacy fallback; new records use `notifications.sticky`. */
  stickyComment?: StickyCommentRef;
}
