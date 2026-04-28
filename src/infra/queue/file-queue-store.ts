import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { hasSameSource, type QueueTaskInput } from "../../domain/queue-task.js";
import type { TaskRecord } from "../../domain/task.js";
import { TASK_STATUSES, type TaskStatus } from "../../domain/task-status.js";
import type {
  CompleteTaskInput,
  QueueStore,
} from "../../domain/ports/queue-store.js";

export interface FileQueueStoreOptions {
  dataDir: string;
}

export function createTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

const TERMINAL_STATUSES = ["succeeded", "failed", "superseded"] as const;

export class FileQueueStore implements QueueStore {
  private readonly dataDir: string;

  constructor(options: FileQueueStoreOptions) {
    this.dataDir = options.dataDir;
  }

  async enqueue(input: QueueTaskInput): Promise<TaskRecord> {
    for (const existing of await this.listInStatus("queued")) {
      if (hasSameSource(existing, input)) {
        existing.status = "superseded";
        await this.relocate(existing, "queued");
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

    await this.writeTaskFile(newTask);
    return newTask;
  }

  async listTasks(): Promise<TaskRecord[]> {
    const all: TaskRecord[] = [];
    for (const status of TASK_STATUSES) {
      all.push(...(await this.listInStatus(status)));
    }
    return all;
  }

  async getTask(taskId: string): Promise<TaskRecord | undefined> {
    for (const status of TASK_STATUSES) {
      const record = await this.tryReadTaskFile(status, taskId);
      if (record !== undefined) {
        return record;
      }
    }
    return undefined;
  }

  async startTask(
    taskId: string,
    instructionRevision: number,
  ): Promise<TaskRecord> {
    const task = await this.requireFromStatus("queued", taskId);

    task.status = "running";
    task.instructionRevision = instructionRevision;
    task.startedAt = new Date().toISOString();
    delete task.finishedAt;
    delete task.errorSummary;

    await this.relocate(task, "queued");
    return task;
  }

  async completeTask(
    taskId: string,
    input: CompleteTaskInput,
  ): Promise<TaskRecord> {
    const task = await this.requireFromStatus("running", taskId);

    task.status = input.status;
    task.finishedAt = new Date().toISOString();

    if (input.errorSummary !== undefined) {
      task.errorSummary = input.errorSummary;
    } else {
      delete task.errorSummary;
    }

    await this.relocate(task, "running");
    return task;
  }

  async revertToQueued(taskId: string): Promise<TaskRecord> {
    const task = await this.requireFromStatus("running", taskId);

    task.status = "queued";
    delete task.startedAt;
    delete task.finishedAt;
    delete task.errorSummary;
    delete task.instructionRevision;

    await this.relocate(task, "running");
    return task;
  }

  async recoverRunningTasks(errorSummary: string): Promise<void> {
    for (const task of await this.listInStatus("running")) {
      task.status = "failed";
      task.finishedAt = new Date().toISOString();
      task.errorSummary = errorSummary;
      await this.relocate(task, "running");
    }
  }

  async pruneTerminalTasks(olderThan: Date): Promise<number> {
    const cutoffMs = olderThan.getTime();
    let pruned = 0;
    for (const status of TERMINAL_STATUSES) {
      const dir = this.statusDir(status);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch (error) {
        if (isMissingFile(error)) {
          continue;
        }
        throw error;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".json")) {
          continue;
        }
        const filePath = path.join(dir, entry);
        try {
          const stats = await stat(filePath);
          if (stats.mtimeMs <= cutoffMs) {
            await unlink(filePath);
            pruned += 1;
          }
        } catch (error) {
          if (!isMissingFile(error)) {
            throw error;
          }
        }
      }
    }
    return pruned;
  }

  private statusDir(status: TaskStatus): string {
    return path.join(this.dataDir, status);
  }

  private taskPath(status: TaskStatus, taskId: string): string {
    return path.join(this.statusDir(status), `${taskId}.json`);
  }

  // Used for new records (enqueue) where there is no fromPath to move from.
  private async writeTaskFile(task: TaskRecord): Promise<void> {
    const target = this.taskPath(task.status, task.taskId);
    const tmp = `${target}.tmp`;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(tmp, JSON.stringify(task, null, 2), "utf8");
    await rename(tmp, target);
  }

  // Two-step atomic transition:
  //   1. Rewrite the old path in place (temp + rename → fromPath). This
  //      refreshes the inode + mtime to "now," so subsequent prune sweeps
  //      that key off mtime see the most recent transition rather than
  //      createdAt.
  //   2. Cross-directory `rename(fromPath, toPath)`. POSIX rename is
  //      atomic within the same filesystem, so the file exists at exactly
  //      one location at any observable moment.
  // If a SIGKILL splits the two steps, the file is still at fromPath with
  // the new content — startup recovery sees a self-consistent record.
  private async relocate(
    task: TaskRecord,
    fromStatus: TaskStatus,
  ): Promise<void> {
    const fromPath = this.taskPath(fromStatus, task.taskId);
    const toPath = this.taskPath(task.status, task.taskId);

    const fromTmp = `${fromPath}.tmp`;
    await mkdir(path.dirname(fromPath), { recursive: true });
    await writeFile(fromTmp, JSON.stringify(task, null, 2), "utf8");
    await rename(fromTmp, fromPath);

    if (fromPath === toPath) {
      return;
    }

    await mkdir(path.dirname(toPath), { recursive: true });
    await rename(fromPath, toPath);
  }

  private async listInStatus(status: TaskStatus): Promise<TaskRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.statusDir(status));
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }
      throw error;
    }
    const records: TaskRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const taskId = entry.slice(0, -".json".length);
      const record = await this.tryReadTaskFile(status, taskId);
      if (record !== undefined) {
        records.push(record);
      }
    }
    // FIFO: readdir order is filesystem-dependent (ext4 hash, btrfs inode,
    // ...), so sort explicitly by the schema field that means "when the
    // task entered the queue."
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return records;
  }

  private async tryReadTaskFile(
    status: TaskStatus,
    taskId: string,
  ): Promise<TaskRecord | undefined> {
    try {
      const raw = await readFile(this.taskPath(status, taskId), "utf8");
      const task = JSON.parse(raw) as TaskRecord;
      if (typeof task.agent !== "string" || task.agent.length === 0) {
        task.agent = "claude";
      }
      return task;
    } catch (error) {
      if (isMissingFile(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private async requireFromStatus(
    status: TaskStatus,
    taskId: string,
  ): Promise<TaskRecord> {
    const task = await this.tryReadTaskFile(status, taskId);
    if (task === undefined) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
