import { header } from "../_shared/helpers.js";
import { COLLECT_ONLY_ALLOWED } from "../_shared/tool-presets.js";
import type { GitHubSourceContext } from "../../domain/github.js";
import type { TaskRecord } from "../../domain/task.js";
import type { Toolkit } from "../types.js";
import { PUBLISHER_TOOL } from "./persona-tool-map.js";

// Publisher only synthesizes the four persona outputs already in memory; it
// does not read the codebase. A 10-minute cap is plenty.
const PUBLISHER_TIMEOUT_MS = 600 * 1000;

export interface PersonaSection {
  readonly id: string;
  readonly label: string;
  readonly tool: string;
  readonly body: string;
}

export type PublisherOutcome =
  | { kind: "succeeded"; synthesis: string }
  | { kind: "failed"; reason: string };

export async function runPublisher(
  tk: Toolkit,
  task: TaskRecord,
  ctx: GitHubSourceContext,
  sections: ReadonlyArray<PersonaSection>,
): Promise<PublisherOutcome> {
  const personaFragments = sections.map((section) => ({
    kind: "literal" as const,
    text: `\n\n## ${section.label} 관점 (${section.tool})\n\n${section.body.trim()}\n`,
  }));

  const result = await tk.ai.run({
    tool: PUBLISHER_TOOL,
    prompt: [
      { kind: "file", path: "_common/work-rules" },
      { kind: "file", path: "personas/publisher" },
      { kind: "file", path: "modes/collect-only" },
      { kind: "literal", text: header(task, ctx) },
      { kind: "literal", text: "\n\n# 분석가 입력 (페르소나별 원자료)" },
      ...personaFragments,
      {
        kind: "user",
        text: "위 페르소나별 원자료를 personas/publisher 의 템플릿대로 통합 보고서로 합성하세요. 한국어로, 결론 먼저.",
      },
    ],
    allowedTools: COLLECT_ONLY_ALLOWED,
    timeoutMs: PUBLISHER_TIMEOUT_MS,
  });

  if (result.kind === "succeeded") {
    return { kind: "succeeded", synthesis: result.stdout };
  }
  if (result.kind === "rate_limited") {
    return {
      kind: "failed",
      reason: `publisher (${result.toolName}) rate-limited`,
    };
  }
  return { kind: "failed", reason: result.errorSummary };
}
