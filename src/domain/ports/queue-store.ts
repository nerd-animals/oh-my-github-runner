import type { QueueTaskInput } from "../queue-task.js";
import type { RepoRef, SourceRef, TaskRecord } from "../task.js";

export interface CompleteTaskInput {
  status: "succeeded" | "failed";
  errorSummary?: string;
}

export interface QueueStore {
  enqueue(task: QueueTaskInput): Promise<TaskRecord>;
  /**
   * Returns every task across all statuses. Within each status, queued tasks
   * are ordered by `createdAt` (FIFO by enqueue order); ordering across
   * statuses is implementation-defined.
   */
  listTasks(): Promise<TaskRecord[]>;
  getTask(taskId: string): Promise<TaskRecord | undefined>;
  startTask(taskId: string): Promise<TaskRecord>;
  completeTask(taskId: string, input: CompleteTaskInput): Promise<TaskRecord>;
  revertToQueued(taskId: string): Promise<TaskRecord>;
  /** Returns queued + running tasks matching (repo, source). */
  findActiveBySource(
    repo: RepoRef,
    source: SourceRef,
  ): Promise<TaskRecord[]>;
  /** Moves a queued- or running-status task into superseded with `supersededBy` set. */
  markSuperseded(taskId: string, supersededBy: string): Promise<TaskRecord>;
  recoverRunningTasks(errorSummary: string): Promise<void>;
  pruneTerminalTasks(olderThan: Date): Promise<number>;
}
