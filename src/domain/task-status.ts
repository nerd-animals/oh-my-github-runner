export const TASK_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "superseded",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
