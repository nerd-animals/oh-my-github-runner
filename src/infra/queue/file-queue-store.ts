import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { hasSameSource, type QueueTaskInput } from "../../domain/queue-task.js";
import type { TaskRecord } from "../../domain/task.js";
import type { CompleteTaskInput, QueueStore } from "../../domain/ports/queue-store.js";

export interface FileQueueStoreOptions {
  dataDir: string;
}

export function createTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export class FileQueueStore implements QueueStore {
  private readonly tasksFilePath: string;

  constructor(options: FileQueueStoreOptions) {
    this.tasksFilePath = path.join(options.dataDir, "tasks.json");
  }

  async enqueue(input: QueueTaskInput): Promise<TaskRecord> {
    const tasks = await this.readTasks();

    for (const task of tasks) {
      if (task.status === "queued" && hasSameSource(task, input)) {
        task.status = "superseded";
      }
    }

    const newTask: TaskRecord = {
      taskId: input.taskId ?? createTaskId(),
      repo: input.repo,
      source: input.source,
      instructionId: input.instructionId,
      agent: input.agent,
      ...(input.additionalInstructions !== undefined &&
      input.additionalInstructions.length > 0
        ? { additionalInstructions: input.additionalInstructions }
        : {}),
      status: "queued",
      priority: input.priority ?? "normal",
      requestedBy: input.requestedBy,
      createdAt: new Date().toISOString(),
      ...(input.stickyComment !== undefined
        ? { stickyComment: input.stickyComment }
        : {}),
    };

    tasks.push(newTask);
    await this.writeTasks(tasks);

    return newTask;
  }

  listTasks(): Promise<TaskRecord[]> {
    return this.readTasks();
  }

  async getTask(taskId: string): Promise<TaskRecord | undefined> {
    const tasks = await this.readTasks();
    return tasks.find((task) => task.taskId === taskId);
  }

  async startTask(
    taskId: string,
    instructionRevision: number,
  ): Promise<TaskRecord> {
    const tasks = await this.readTasks();
    const task = this.requireTask(tasks, taskId);

    task.status = "running";
    task.instructionRevision = instructionRevision;
    task.startedAt = new Date().toISOString();
    delete task.finishedAt;
    delete task.errorSummary;

    await this.writeTasks(tasks);
    return task;
  }

  async completeTask(
    taskId: string,
    input: CompleteTaskInput,
  ): Promise<TaskRecord> {
    const tasks = await this.readTasks();
    const task = this.requireTask(tasks, taskId);

    task.status = input.status;
    task.finishedAt = new Date().toISOString();

    if (input.errorSummary !== undefined) {
      task.errorSummary = input.errorSummary;
    } else {
      delete task.errorSummary;
    }

    await this.writeTasks(tasks);
    return task;
  }

  async revertToQueued(taskId: string): Promise<TaskRecord> {
    const tasks = await this.readTasks();
    const task = this.requireTask(tasks, taskId);

    task.status = "queued";
    delete task.startedAt;
    delete task.finishedAt;
    delete task.errorSummary;
    delete task.instructionRevision;

    await this.writeTasks(tasks);
    return task;
  }

  async recoverRunningTasks(errorSummary: string): Promise<void> {
    const tasks = await this.readTasks();
    let changed = false;

    for (const task of tasks) {
      if (task.status !== "running") {
        continue;
      }

      task.status = "failed";
      task.finishedAt = new Date().toISOString();
      task.errorSummary = errorSummary;
      changed = true;
    }

    if (changed) {
      await this.writeTasks(tasks);
    }
  }

  private requireTask(tasks: TaskRecord[], taskId: string): TaskRecord {
    const task = tasks.find((candidate) => candidate.taskId === taskId);

    if (task === undefined) {
      throw new Error(`Task not found: ${taskId}`);
    }

    return task;
  }

  private async readTasks(): Promise<TaskRecord[]> {
    try {
      const raw = await readFile(this.tasksFilePath, "utf8");
      const tasks = JSON.parse(raw) as TaskRecord[];

      for (const task of tasks) {
        if (typeof task.agent !== "string" || task.agent.length === 0) {
          task.agent = "claude";
        }
      }

      return tasks;
    } catch (error) {
      const isMissingFile =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT";

      if (isMissingFile) {
        return [];
      }

      throw error;
    }
  }

  private async writeTasks(tasks: TaskRecord[]): Promise<void> {
    const dirPath = path.dirname(this.tasksFilePath);
    const tempFilePath = `${this.tasksFilePath}.tmp`;

    await mkdir(dirPath, { recursive: true });
    await writeFile(tempFilePath, JSON.stringify(tasks, null, 2), "utf8");
    await rename(tempFilePath, this.tasksFilePath);
  }
}
