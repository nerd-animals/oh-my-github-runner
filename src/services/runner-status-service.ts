import type { QueueStore } from "../domain/ports/queue-store.js";
import type { TaskRecord } from "../domain/task.js";

export interface TaskCounts {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  superseded: number;
}

export type RunnerToolStatus = "idle" | "busy";

export interface RunnerToolEntry {
  tool: string;
  status: RunnerToolStatus;
}

export interface RunnerStatusSummary {
  status: "ok";
  tasks: TaskCounts;
  runners: RunnerToolEntry[];
}

export interface RunnerStatusServiceOptions {
  queueStore: Pick<QueueStore, "listTasks">;
  registeredTools: readonly string[];
  toolsForTask: (task: TaskRecord) => readonly string[];
}

export class RunnerStatusService {
  constructor(private readonly opts: RunnerStatusServiceOptions) {}

  async getStatus(): Promise<RunnerStatusSummary> {
    const tasks = await this.opts.queueStore.listTasks();

    const counts: TaskCounts = {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      superseded: 0,
    };

    const busy = new Set<string>();

    for (const task of tasks) {
      counts[task.status] += 1;

      if (task.status === "running") {
        for (const tool of this.opts.toolsForTask(task)) {
          busy.add(tool);
        }
      }
    }

    const runners: RunnerToolEntry[] = this.opts.registeredTools.map(
      (tool) => ({
        tool,
        status: busy.has(tool) ? "busy" : "idle",
      }),
    );

    return { status: "ok", tasks: counts, runners };
  }
}
