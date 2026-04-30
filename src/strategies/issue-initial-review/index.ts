import { header, mapAiFailure, ok } from "../_shared/helpers.js";
import {
  COLLECT_ONLY_ALLOWED,
  COLLECT_ONLY_DISALLOWED,
} from "../_shared/tool-presets.js";
import type { ExecuteResult, Strategy } from "../types.js";
import type { TaskRecord } from "../../domain/task.js";
import { PERSONAS, TOOL_MAP } from "./persona-tool-map.js";

const PER_PERSONA_TIMEOUT_MS = 1800 * 1000;
// Personas now run in parallel; wall-clock budget approaches max(per-persona)
// rather than sum, so the strategy-level cap can be tighter than before.
const TIMEOUT_MS = PER_PERSONA_TIMEOUT_MS * 2;

export const issueInitialReviewStrategy: Strategy = {
  policies: { tool: "claude", supersedeOnSameSource: true, timeoutMs: TIMEOUT_MS },
  run: async (task, tk, signal) => {
    signal.throwIfAborted();
    await using ws = await tk.workspace.prepareObserve(task);
    void ws;

    signal.throwIfAborted();
    const ctx = await tk.github.fetchContext(task);

    signal.throwIfAborted();
    const settled = await Promise.all(
      PERSONAS.map(async (persona) => {
        const result = await tk.ai.run({
          tool: TOOL_MAP[persona.id],
          prompt: [
            { kind: "file", path: "_common/work-rules" },
            { kind: "file", path: `personas/${persona.id}` },
            { kind: "file", path: "modes/collect-only" },
            { kind: "literal", text: header(task, ctx) },
            { kind: "context", key: "issue-body" },
            { kind: "context", key: "linked-refs" },
            { kind: "user", text: task.additionalInstructions ?? "" },
          ],
          allowedTools: COLLECT_ONLY_ALLOWED,
          disallowedTools: COLLECT_ONLY_DISALLOWED,
          timeoutMs: PER_PERSONA_TIMEOUT_MS,
        });
        return { persona, result };
      }),
    );

    // rate_limited wins over failed: the queue retries the whole task once
    // every tool is available again, so we surface that signal first.
    for (const { result } of settled) {
      if (result.kind === "rate_limited") {
        return mapAiFailure(result);
      }
    }
    for (const { result } of settled) {
      if (result.kind === "failed") {
        return mapAiFailure(result);
      }
    }

    const sections = settled.map(({ persona, result }) => {
      if (result.kind !== "succeeded") {
        throw new Error("unreachable: rate_limited/failed checked above");
      }
      return { label: persona.label, body: result.stdout };
    });

    signal.throwIfAborted();
    await tk.github.postIssueComment(
      task.repo,
      task.source.number,
      renderReport(task, ctx.title, sections),
    );
    return ok();
  },
};

function renderReport(
  task: TaskRecord,
  title: string,
  sections: ReadonlyArray<{ label: string; body: string }>,
): string {
  const lines: string[] = [];
  lines.push(`## ${title}`);
  lines.push("");
  lines.push(`🤖 자동 분석 — \`${task.instructionId}\` (\`${task.taskId}\`)`);
  for (const section of sections) {
    const trimmed = section.body.trim();
    if (trimmed.length === 0) {
      continue;
    }
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(`### ${section.label} 관점`);
    lines.push("");
    lines.push(trimmed);
  }
  return lines.join("\n");
}

export type { ExecuteResult };
