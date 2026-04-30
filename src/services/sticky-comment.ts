import type { TaskRecord } from "../domain/task.js";
import { getStrategy, hasStrategy } from "../strategies/index.js";
import type { TriggerLocation } from "./event-dispatcher.js";

export interface StickyCommentMeta {
  taskId: string;
  instructionId: string;
  /** Names of tools the strategy may route to (lookup of policies.uses). */
  tools: readonly string[];
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

function formatToolsCell(tools: readonly string[]): string {
  if (tools.length === 0) return "`—`";
  return tools.map((t) => `\`${t}\``).join(", ");
}

function lookupTaskTools(task: TaskRecord): readonly string[] {
  if (!hasStrategy(task.instructionId)) return [];
  return Object.keys(getStrategy(task.instructionId).policies.uses);
}

function queuedMetaTable(meta: StickyCommentMeta): string {
  const toolsLabel = meta.tools.length === 1 ? "tool" : "tools";
  return [
    "| key | value |",
    "|---|---|",
    `| instruction | \`${meta.instructionId}\` |`,
    `| ${toolsLabel} | ${formatToolsCell(meta.tools)} |`,
    `| triggered by | @${meta.requestedBy} |`,
    `| trigger | ${describeTrigger(meta.trigger)} |`,
  ].join("\n");
}

function taskMetaTable(task: TaskRecord): string {
  const tools = lookupTaskTools(task);
  const toolsLabel = tools.length === 1 ? "tool" : "tools";
  return [
    "| key | value |",
    "|---|---|",
    `| instruction | \`${task.instructionId}\` |`,
    `| ${toolsLabel} | ${formatToolsCell(tools)} |`,
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
    "_Will resume automatically once the tool's rate limit clears._",
  ].join("\n");
}

export function renderSuperseded(
  task: TaskRecord,
  supersededBy: string,
): string {
  return [
    stickyCommentMarker(task.taskId),
    `🔁 **Task superseded** — \`${task.taskId}\``,
    "",
    taskMetaTable(task),
    "",
    `_Replaced by a newer trigger: \`${supersededBy}\`._`,
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
