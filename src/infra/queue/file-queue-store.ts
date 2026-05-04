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
import type { RepoRef, SourceRef, TaskRecord } from "../../domain/task.js";
import { TASK_STATUSES, type TaskStatus } from "../../domain/task-status.js";
import type {
  CompleteTaskInput,
  QueueStore,
} from "../../domain/ports/queue-store.js";

export interface FileQueueStoreOptions {
  dataDir: string;
  warn?: (message: string) => void;
}

export function createTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

const TERMINAL_STATUSES = ["succeeded", "failed", "superseded"] as const;
// Top-level directory siblings of the status directories (queued/, running/,
// ...) where corrupt task JSON files are quarantined. Picked deliberately
// outside TASK_STATUSES so listInStatus / pruneTerminalTasks never walk it
// and so it never collides with the supersede-on-same-source semantics of
// `superseded/`.
const CORRUPT_DIR = "corrupt";

export class FileQueueStore implements QueueStore {
  private readonly dataDir: string;
  private readonly warn: (message: string) => void;
  // Monotonic guard: when two enqueue() calls land in the same millisecond,
  // bump the next createdAt by +1ms so the FIFO sort key stays strictly
  // increasing. Without this the sort tie-breaks on readdir order, which is
  // filesystem-dependent (alphabetical on most ext4/tmpfs) and breaks the
  // "queued tasks come out in enqueue order" contract.
  private lastCreatedAtMs = 0;

  constructor(options: FileQueueStoreOptions) {
    this.dataDir = options.dataDir;
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  async enqueue(input: QueueTaskInput): Promise<TaskRecord> {
    // Supersede-on-same-source is a service-layer policy now: EnqueueService
    // reads the strategy's `supersedeOnSameSource` flag and calls
    // markSuperseded(...) for each conflicting active task. The store is
    // a dumb persistence layer.

    const newTask: TaskRecord = {
      taskId: input.taskId ?? createTaskId(),
      repo: input.repo,
      source: input.source,
      instructionId: input.instructionId,
      ...(input.additionalInstructions !== undefined &&
      input.additionalInstructions.length > 0
        ? { additionalInstructions: input.additionalInstructions }
        : {}),
      status: "queued",
      priority: input.priority ?? "normal",
      requestedBy: input.requestedBy,
      createdAt: this.nextCreatedAt(),
      ...(input.notifications !== undefined &&
      (input.notifications.sticky !== undefined ||
        input.notifications.trigger !== undefined)
        ? { notifications: input.notifications }
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

  async startTask(taskId: string): Promise<TaskRecord> {
    const task = await this.requireFromStatus("queued", taskId);

    task.status = "running";
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

    await this.relocate(task, "running");
    return task;
  }

  async findActiveBySource(
    repo: RepoRef,
    source: SourceRef,
  ): Promise<TaskRecord[]> {
    const queued = await this.listInStatus("queued");
    const running = await this.listInStatus("running");
    return [...queued, ...running].filter((task) =>
      hasSameSource(task, { repo, source }),
    );
  }

  async markSuperseded(
    taskId: string,
    supersededBy: string,
  ): Promise<TaskRecord> {
    for (const status of ["queued", "running"] as const) {
      const task = await this.tryReadTaskFile(status, taskId);
      if (task === undefined) {
        continue;
      }
      task.status = "superseded";
      task.supersededBy = supersededBy;
      task.finishedAt = new Date().toISOString();
      delete task.errorSummary;
      await this.relocate(task, status);
      return task;
    }
    throw new Error(
      `Cannot supersede task '${taskId}': not in queued or running status`,
    );
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

  private nextCreatedAt(): string {
    const now = Date.now();
    const next = now > this.lastCreatedAtMs ? now : this.lastCreatedAtMs + 1;
    this.lastCreatedAtMs = next;
    return new Date(next).toISOString();
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
    let raw: string;
    try {
      raw = await readFile(this.taskPath(status, taskId), "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return undefined;
      }
      throw error;
    }

    try {
      return JSON.parse(raw) as TaskRecord;
    } catch (error) {
      // Corrupt task JSON (e.g. half-written after a non-graceful shutdown).
      // Move it aside so daemon startup / queue scans keep working, but
      // preserve it under corrupt/ so the user can inspect or recover it
      // manually — the task record is the only authoritative log of what
      // was queued.
      const reason = error instanceof Error ? error.message : String(error);
      await this.quarantineCorruptFile(status, taskId, reason);
      return undefined;
    }
  }

  private async quarantineCorruptFile(
    status: TaskStatus,
    taskId: string,
    reason: string,
  ): Promise<void> {
    const fromPath = this.taskPath(status, taskId);
    const corruptDir = path.join(this.dataDir, CORRUPT_DIR, status);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const toPath = path.join(corruptDir, `${taskId}.${stamp}.json`);

    try {
      await mkdir(corruptDir, { recursive: true });
      await rename(fromPath, toPath);
      this.warn(
        `[file-queue-store] quarantined corrupt task file ${fromPath} -> ${toPath}: ${reason}`,
      );
    } catch (moveError) {
      // The file may have vanished between read and rename, or rename may
      // fail across filesystems. Either way the daemon must keep going —
      // surface the failure as a warning instead of throwing.
      const moveReason =
        moveError instanceof Error ? moveError.message : String(moveError);
      this.warn(
        `[file-queue-store] failed to quarantine corrupt task file ${fromPath}: ${moveReason} (original parse error: ${reason})`,
      );
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
