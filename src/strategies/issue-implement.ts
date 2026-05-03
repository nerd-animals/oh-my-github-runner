import { header, mapAiFailure, ok } from "./_shared/helpers.js";
import { MUTATE_ALLOWED, MUTATE_DISALLOWED } from "./_shared/tool-presets.js";
import type { Strategy } from "./types.js";

const TIMEOUT_MS = 3600 * 1000;

export const issueImplementStrategy: Strategy = {
  policies: { uses: { claude: true }, supersedeOnSameSource: true, timeoutMs: TIMEOUT_MS },
  run: async (task, tk, signal) => {
    signal.throwIfAborted();
    const ctx = await tk.github.fetchContext(task);

    signal.throwIfAborted();
    await using ws = await tk.workspace.prepareMutate(task);
    void ws;

    signal.throwIfAborted();
    const result = await tk.ai.run({
      prompt: [
        { kind: "file", path: "_common/work-rules" },
        { kind: "file", path: "_common/tone" },
        { kind: "file", path: "_common/engineering-stance" },
        { kind: "file", path: "personas/implementation" },
        { kind: "literal", text: header(task, ctx) },
        { kind: "file", path: "modes/mutate" },
        { kind: "file", path: "guidance/issue-implement" },
        { kind: "omgr-doc", path: ".omgr/architecture.md" },
        { kind: "omgr-doc", path: ".omgr/testing.md" },
        { kind: "context", key: "issue-body" },
        { kind: "context", key: "issue-comments" },
        { kind: "context", key: "linked-refs" },
        { kind: "user", text: task.additionalInstructions ?? "" },
      ],
      allowedTools: MUTATE_ALLOWED,
      disallowedTools: MUTATE_DISALLOWED,
      timeoutMs: TIMEOUT_MS,
    });

    return result.kind === "succeeded" ? ok() : mapAiFailure(result);
  },
};
