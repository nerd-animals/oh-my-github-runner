import type { InstructionDefinition } from "../instruction.js";
import type { TaskRecord } from "../task.js";

export interface SelectNextTasksInput {
  tasks: TaskRecord[];
  instructionsById: Record<string, InstructionDefinition>;
  maxConcurrency: number;
  pausedAgents?: ReadonlySet<string>;
}

export function selectNextTasks(input: SelectNextTasksInput): string[] {
  const pausedAgents = input.pausedAgents ?? new Set<string>();
  const runningTasks = input.tasks.filter((task) => task.status === "running");
  const queuedTasks = input.tasks.filter((task) => task.status === "queued");
  const availableSlots = input.maxConcurrency - runningTasks.length;

  if (availableSlots <= 0) {
    return [];
  }

  const selected: string[] = [];
  const runningMutateRepos = new Set(
    runningTasks
      .filter(
        (task) => input.instructionsById[task.instructionId]?.mode === "mutate",
      )
      .map(getRepoKey),
  );
  const selectedMutateRepos = new Set<string>();

  for (const task of queuedTasks) {
    if (selected.length >= availableSlots) {
      break;
    }

    if (pausedAgents.has(task.agent)) {
      continue;
    }

    const instruction = input.instructionsById[task.instructionId];

    if (instruction === undefined) {
      continue;
    }

    if (instruction.mode === "mutate") {
      const repoKey = getRepoKey(task);

      if (
        runningMutateRepos.has(repoKey) ||
        selectedMutateRepos.has(repoKey)
      ) {
        continue;
      }

      selectedMutateRepos.add(repoKey);
    }

    selected.push(task.taskId);
  }

  return selected;
}

function getRepoKey(task: Pick<TaskRecord, "repo">): string {
  return `${task.repo.owner}/${task.repo.name}`;
}
