import type { TaskRecord } from "../../domain/task.js";
import type { PersonaSection } from "./publisher.js";

export interface RenderInput {
  readonly task: TaskRecord;
  readonly title: string;
  readonly sections: ReadonlyArray<PersonaSection>;
  /** Publisher synthesis when available; null when the publisher failed. */
  readonly synthesis: string | null;
  /** When `synthesis` is null, a short note explaining why. */
  readonly fallbackNote: string | null;
}

export function renderReport(input: RenderInput): string {
  const { task, title, sections, synthesis, fallbackNote } = input;
  const lines: string[] = [];

  lines.push(`## ${title}`);
  lines.push("");
  lines.push(`🤖 자동 분석 — \`${task.instructionId}\` (\`${task.taskId}\`)`);

  if (synthesis !== null) {
    const trimmed = synthesis.trim();
    if (trimmed.length > 0) {
      lines.push("");
      lines.push(trimmed);
    }
  } else if (fallbackNote !== null) {
    lines.push("");
    lines.push(`> ⚠️ ${fallbackNote}`);
  }

  const nonEmpty = sections.filter((s) => s.body.trim().length > 0);
  if (nonEmpty.length > 0) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("### 페르소나별 원본 분석");
    for (const section of nonEmpty) {
      lines.push("");
      lines.push(
        `<details><summary>${section.label} 관점 (${section.tool})</summary>`,
      );
      lines.push("");
      lines.push(section.body.trim());
      lines.push("");
      lines.push("</details>");
    }
  }

  return lines.join("\n");
}
