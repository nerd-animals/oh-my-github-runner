import type { TaskRecord } from "../domain/task.js";
import type { TriggerLocation } from "./event-dispatcher.js";

export interface StickyCommentMeta {
  taskId: string;
  instructionId: string;
  agent: string;
  requestedBy: string;
  trigger: TriggerLocation;
}

export function stickyCommentMarker(taskId: string): string {
  return `<!-- omgr:task=${taskId} -->`;
}

export const REJECTION_MARKER = "<!-- omgr:rejected -->";

function describeTrigger(trigger: TriggerLocation): string {
  if (trigger.kind === "issue") {
    return `issue #${trigger.issueNumber} opened`;
  }

  return `comment on #${trigger.issueNumber}`;
}

function describeSource(task: TaskRecord): string {
  return `${task.source.kind === "issue" ? "issue" : "PR"} #${task.source.number}`;
}

function queuedMetaTable(meta: StickyCommentMeta): string {
  return [
    "| key | value |",
    "|---|---|",
    `| instruction | \`${meta.instructionId}\` |`,
    `| agent | \`${meta.agent}\` |`,
    `| triggered by | @${meta.requestedBy} |`,
    `| trigger | ${describeTrigger(meta.trigger)} |`,
  ].join("\n");
}

function taskMetaTable(task: TaskRecord): string {
  return [
    "| key | value |",
    "|---|---|",
    `| instruction | \`${task.instructionId}\` |`,
    `| agent | \`${task.agent}\` |`,
    `| triggered by | @${task.requestedBy} |`,
    `| source | ${describeSource(task)} |`,
  ].join("\n");
}

export function renderQueued(meta: StickyCommentMeta): string {
  return [
    stickyCommentMarker(meta.taskId),
    `🤖 **Task queued** — \`${meta.taskId}\``,
    "",
    queuedMetaTable(meta),
    "",
    "_This comment will be updated when the task completes._",
  ].join("\n");
}

export function renderFailure(task: TaskRecord, errorSummary: string): string {
  return [
    stickyCommentMarker(task.taskId),
    `❌ **Task failed** — \`${task.taskId}\``,
    "",
    taskMetaTable(task),
    "",
    "**Error**:",
    "",
    "```",
    truncate(errorSummary, 1500),
    "```",
  ].join("\n");
}

export function renderRateLimited(task: TaskRecord): string {
  return [
    stickyCommentMarker(task.taskId),
    `⏳ **Task waiting on rate-limit reset** — \`${task.taskId}\``,
    "",
    taskMetaTable(task),
    "",
    "_Will resume automatically once the agent's rate limit clears._",
  ].join("\n");
}

export function renderRejection(
  reason: string,
  body: string,
  meta: { requestedBy: string; trigger: TriggerLocation },
): string {
  return [
    REJECTION_MARKER,
    `❌ **Trigger rejected** — ${reason}`,
    "",
    `Triggered by @${meta.requestedBy} via ${describeTrigger(meta.trigger)}`,
    "",
    body,
  ].join("\n");
}

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) {
    return value;
  }

  return `${value.slice(0, maxLen)}…`;
}
