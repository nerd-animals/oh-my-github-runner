import { header, mapAiFailure, ok } from "./_shared/helpers.js";
import { OBSERVE_ALLOWED, OBSERVE_DISALLOWED } from "./_shared/tool-presets.js";
import type { Strategy } from "./types.js";

const TIMEOUT_MS = 1800 * 1000;

export const issueCommentReplyStrategy: Strategy = {
  policies: { tool: "claude", supersedeOnSameSource: true, timeoutMs: TIMEOUT_MS },
  run: async (task, tk, signal) => {
    signal.throwIfAborted();
    await using ws = await tk.workspace.prepareObserve(task);
    void ws;

    signal.throwIfAborted();
    const ctx = await tk.github.fetchContext(task);

    signal.throwIfAborted();
    const result = await tk.ai.run({
      tool: task.tool,
      prompt: [
        { kind: "file", path: "_common/work-rules" },
        { kind: "file", path: "personas/architecture" },
        { kind: "literal", text: header(task, ctx) },
        { kind: "file", path: "modes/observe" },
        { kind: "context", key: "issue-body" },
        { kind: "context", key: "issue-comments" },
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
