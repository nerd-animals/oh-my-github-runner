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
  /**
   * Returns queued tasks matching (repo, source). Running tasks are
   * intentionally excluded — supersede acts only on still-pending work,
   * never on a task that has already started side effects.
   */
  findQueuedBySource(
    repo: RepoRef,
    source: SourceRef,
  ): Promise<TaskRecord[]>;
  /**
   * Moves a queued-status task into superseded with `supersededBy` set.
   * Throws if the task is not currently in queued (e.g. already running,
   * already terminal, or not found) — supersede is queued-only.
   */
  markSuperseded(taskId: string, supersededBy: string): Promise<TaskRecord>;
  recoverRunningTasks(errorSummary: string): Promise<void>;
  pruneTerminalTasks(olderThan: Date): Promise<number>;
}
