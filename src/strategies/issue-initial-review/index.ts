import { header, mapAiFailure, ok } from "../_shared/helpers.js";
import { COLLECT_ONLY_ALLOWED } from "../_shared/tool-presets.js";
import type { Strategy } from "../types.js";
import { PERSONAS, TOOL_MAP } from "./persona-tool-map.js";
import { runPublisher, type PersonaSection } from "./publisher.js";
import { renderReport } from "./render.js";

const PER_PERSONA_TIMEOUT_MS = 1800 * 1000;
// Personas now run in parallel and the daemon defers the task until every
// tool in `uses` is clear of rate-limit, so wall-clock budget is closer to
// max(per-persona) + publisher rather than sum.
const TIMEOUT_MS = PER_PERSONA_TIMEOUT_MS * 2;

export const issueInitialReviewStrategy: Strategy = {
  policies: {
    uses: { claude: true, codex: true, gemini: true },
    supersedeOnSameSource: true,
    timeoutMs: TIMEOUT_MS,
  },
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

    const sections: PersonaSection[] = settled.map(({ persona, result }) => {
      if (result.kind !== "succeeded") {
        throw new Error("unreachable: rate_limited/failed checked above");
      }
      return {
        id: persona.id,
        label: persona.label,
        tool: TOOL_MAP[persona.id],
        body: result.stdout,
      };
    });

    signal.throwIfAborted();
    // Publisher failure (failed or rate_limited) does NOT invalidate the
    // expensive persona output already in hand. Fall back to appendix-only
    // with a one-line note instead of returning rate_limited / failed —
    // re-running the strategy would just redo the four persona calls.
    const publisher = await runPublisher(tk, task, ctx, sections);

    signal.throwIfAborted();
    const body = renderReport({
      task,
      title: ctx.title,
      sections,
      synthesis: publisher.kind === "succeeded" ? publisher.synthesis : null,
      fallbackNote:
        publisher.kind === "failed"
          ? `통합 요약 생성에 실패했습니다 — ${publisher.reason}. 페르소나 결과만 부록으로 게시합니다.`
          : null,
    });

    await tk.github.postIssueComment(task.repo, task.source.number, body);
    return ok();
  },
};
