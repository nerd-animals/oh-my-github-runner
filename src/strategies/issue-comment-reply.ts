import { header, mapAiFailure, ok } from "./_shared/helpers.js";
import { OBSERVE_ALLOWED, REPLY_DISALLOWED } from "./_shared/tool-presets.js";
import type { Strategy } from "./types.js";

const TIMEOUT_MS = 1800 * 1000;

export const issueCommentReplyStrategy: Strategy = {
  policies: { uses: { codex: true }, supersedeOnSameSource: true, timeoutMs: TIMEOUT_MS },
  run: async (task, tk, signal) => {
    signal.throwIfAborted();
    await using ws = await tk.workspace.prepareObserve(task);
    void ws;

    signal.throwIfAborted();
    const ctx = await tk.github.fetchContext(task);

    signal.throwIfAborted();
    const result = await tk.ai.run({
      prompt: [
        { kind: "file", path: "_common/work-rules" },
        { kind: "file", path: "personas/reply" },
        { kind: "literal", text: header(task, ctx) },
        { kind: "file", path: "modes/observe" },
        { kind: "file", path: "_common/omgr-docs" },
        { kind: "context", key: "issue-body" },
        { kind: "context", key: "issue-comments" },
        { kind: "context", key: "linked-refs" },
        { kind: "user", text: task.additionalInstructions ?? "" },
      ],
      allowedTools: OBSERVE_ALLOWED,
      disallowedTools: REPLY_DISALLOWED,
      timeoutMs: TIMEOUT_MS,
    });

    return result.kind === "succeeded" ? ok() : mapAiFailure(result);
  },
};
