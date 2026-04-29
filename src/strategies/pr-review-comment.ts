import { header, mapAiFailure, ok } from "./_shared/helpers.js";
import { OBSERVE_ALLOWED, OBSERVE_DISALLOWED } from "./_shared/tool-presets.js";
import type { Strategy } from "./types.js";

const TIMEOUT_MS = 1800 * 1000;

export const prReviewCommentStrategy: Strategy = {
  policies: { supersedeOnSameSource: true, timeoutMs: TIMEOUT_MS },
  run: async (task, tk, signal) => {
    signal.throwIfAborted();
    const ctx = await tk.github.fetchContext(task);
    if (ctx.kind !== "pull_request") {
      return {
        status: "failed",
        errorSummary: "pr-review-comment requires a pull_request source",
      };
    }

    signal.throwIfAborted();
    await using ws = await tk.workspace.prepareObserve(task, ctx.headRef);
    void ws;

    signal.throwIfAborted();
    const result = await tk.ai.run({
      tool: task.tool,
      prompt: [
        { kind: "file", path: "_common/work-rules" },
        { kind: "file", path: "personas/architecture" },
        { kind: "literal", text: header(task, ctx) },
        { kind: "file", path: "modes/observe" },
        { kind: "context", key: "pr-body" },
        { kind: "context", key: "pr-comments" },
        { kind: "context", key: "pr-diff" },
        { kind: "context", key: "pr-base-head" },
        { kind: "context", key: "linked-refs" },
        { kind: "user", text: task.additionalInstructions ?? "" },
      ],
      allowedTools: OBSERVE_ALLOWED,
      disallowedTools: OBSERVE_DISALLOWED,
      timeoutMs: TIMEOUT_MS,
    });

    return result.kind === "succeeded" ? ok() : mapAiFailure(result);
  },
};
