import type { QueueTaskInput } from "../../domain/queue-task.js";
import type { TaskRecord } from "../../domain/task.js";

export interface CompleteTaskInput {
  status: "succeeded" | "failed";
  errorSummary?: string;
}

export interface QueueStore {
  enqueue(task: QueueTaskInput): Promise<TaskRecord>;
  listTasks(): Promise<TaskRecord[]>;
  getTask(taskId: string): Promise<TaskRecord | undefined>;
  startTask(taskId: string, instructionRevision: number): Promise<TaskRecord>;
  completeTask(taskId: string, input: CompleteTaskInput): Promise<TaskRecord>;
  revertToQueued(taskId: string): Promise<TaskRecord>;
  recoverRunningTasks(errorSummary: string): Promise<void>;
}
