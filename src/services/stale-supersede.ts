import type { TaskRecord } from "../domain/task.js";

/**
 * Returns true when an observe task should skip writing back its result
 * because a newer task targeting the same (repo, source, instructionId)
 * is queued or running. Mode is implied by matching instructionId; the
 * caller only invokes this for observe tasks.
 */
export function isObserveResultSuperseded(
  current: TaskRecord,
  others: readonly TaskRecord[],
): boolean {
  const currentCreated = Date.parse(current.createdAt);

  for (const other of others) {
    if (other.taskId === current.taskId) {
      continue;
    }

    if (other.status !== "queued" && other.status !== "running") {
      continue;
    }

    if (other.repo.owner !== current.repo.owner) {
      continue;
    }

    if (other.repo.name !== current.repo.name) {
      continue;
    }

    if (other.source.kind !== current.source.kind) {
      continue;
    }

    if (other.source.number !== current.source.number) {
      continue;
    }

    if (other.instructionId !== current.instructionId) {
      continue;
    }

    if (Date.parse(other.createdAt) <= currentCreated) {
      continue;
    }

    return true;
  }

  return false;
}
