import type { TaskRecord } from "../task.js";

/**
 * Tools that every task implicitly depends on, regardless of what the
 * strategy declares in `policies.uses`. When any of these is paused the
 * scheduler defers ALL tasks — there is no way to make progress without
 * the resource. Currently just "github": every task fetches issue/PR
 * context and posts comments, so a runner-side GitHub rate-limit grounds
 * the queue. Strategies must NOT list these in `policies.uses`; they are
 * not per-strategy AI tools and should not enter the per-tool concurrency
 * cap that #110 introduced.
 */
export const GLOBAL_TOOLS: ReadonlySet<string> = new Set(["github"]);

export interface SelectNextTasksInput {
  tasks: TaskRecord[];
  maxConcurrency: number;
  pausedTools?: ReadonlySet<string>;
  /**
   * Maps a task's instructionId to the set of tool names its strategy
   * may use. The scheduler defers any queued task whose set intersects
   * with `pausedTools`.
   */
  toolsForTask: (task: TaskRecord) => readonly string[];
}

// Pure FIFO scheduling against the concurrency budget. Two skip rules:
//   1. Tool is rate-limit-paused.
//   2. Tool is already claimed by another in-flight task — either currently
//      running, or selected earlier in this same tick (issue #110). Without
//      this cap, two queued tasks sharing a tool got dispatched together;
//      the first task's eventual 429 wrote a pause too late to stop the
//      second from also hitting 429. Per-tool budget = 1.
// Multi-tool strategies (e.g. issue-initial-review with claude + codex)
// claim every tool they declare. Persona steps run sequentially inside a
// task, so we cannot assume the task is using "only" one tool right now —
// any concurrent same-strategy task could collide on either side.
// Same-repo mutate serialization is intentionally not enforced here: branch
// names include a taskId suffix so concurrent mutate runs cannot collide on
// a branch, and same-source duplicate triggers are handled by
// supersede-on-enqueue.
export function selectNextTasks(input: SelectNextTasksInput): string[] {
  const pausedTools = input.pausedTools ?? new Set<string>();

  // Global pause: a paused GLOBAL_TOOL grounds every task because every
  // strategy depends on it. Returns empty without touching the per-tool
  // accounting below — GLOBAL_TOOLS are intentionally not declared in
  // `policies.uses` so they never enter the per-tool in-flight cap.
  for (const tool of GLOBAL_TOOLS) {
    if (pausedTools.has(tool)) {
      return [];
    }
  }

  const running = input.tasks.filter((task) => task.status === "running");
  const slots = input.maxConcurrency - running.length;

  if (slots <= 0) {
    return [];
  }

  const inFlightTools = new Set<string>();
  for (const task of running) {
    for (const tool of input.toolsForTask(task)) {
      inFlightTools.add(tool);
    }
  }

  const selected: string[] = [];
  for (const task of input.tasks.filter((t) => t.status === "queued")) {
    if (selected.length >= slots) {
      break;
    }
    const taskTools = input.toolsForTask(task);
    if (taskTools.some((t) => pausedTools.has(t))) {
      continue;
    }
    if (taskTools.some((t) => inFlightTools.has(t))) {
      continue;
    }
    selected.push(task.taskId);
    for (const tool of taskTools) {
      inFlightTools.add(tool);
    }
  }
  return selected;
}
