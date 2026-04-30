import { header, mapAiFailure, ok } from "./_shared/helpers.js";
import { COLLECT_ONLY_ALLOWED } from "./_shared/tool-presets.js";
import type { ExecuteResult, Strategy } from "./types.js";
import type { TaskRecord } from "../domain/task.js";

const PERSONAS = [
  { id: "architect", label: "Architect" },
  { id: "test", label: "Test" },
  { id: "ops", label: "Ops" },
  { id: "maintenance", label: "Maintenance" },
] as const;

const PER_PERSONA_TIMEOUT_MS = 1800 * 1000;
// Loose total budget so 5 sequential personas don't all run for 30 minutes.
const TIMEOUT_MS = PER_PERSONA_TIMEOUT_MS * PERSONAS.length;

export const issueInitialReviewStrategy: Strategy = {
  policies: { uses: { claude: true }, supersedeOnSameSource: true, timeoutMs: TIMEOUT_MS },
  run: async (task, tk, signal) => {
    signal.throwIfAborted();
    await using ws = await tk.workspace.prepareObserve(task);
    void ws;

    signal.throwIfAborted();
    const ctx = await tk.github.fetchContext(task);

    const sections: Array<{ label: string; body: string }> = [];

    for (const persona of PERSONAS) {
      signal.throwIfAborted();
      const result = await tk.ai.run({
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
        timeoutMs: PER_PERSONA_TIMEOUT_MS,
      });

      if (result.kind !== "succeeded") {
        return mapAiFailure(result);
      }
      sections.push({ label: persona.label, body: result.stdout });
    }

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

// Re-export for tests that want to verify rendering without spinning up
// the whole strategy.
export const __testing = { renderReport, PERSONAS };

// Suppress unused-export warnings — ExecuteResult is the public type strategies return.
export type { ExecuteResult };
