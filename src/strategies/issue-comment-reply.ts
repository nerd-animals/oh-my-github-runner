import { header, mapAiFailure, ok } from "./_shared/helpers.js";
import {
  COLLECT_ONLY_ALLOWED,
} from "./_shared/tool-presets.js";
import {
  ISSUE_COMMENT_REPLY_OUTPUT_SCHEMA,
  formatFailedActionReceipt,
  formatSucceededActionReceipt,
  parseIssueCommentReplyEnvelope,
  renderAdditionalActionReceipts,
} from "./_shared/reply-actions.js";
import type { Strategy } from "./types.js";

const TIMEOUT_MS = 1800 * 1000;

export const issueCommentReplyStrategy: Strategy = {
  policies: {
    uses: { codex: true },
    supersedeOnSameSource: true,
    timeoutMs: TIMEOUT_MS,
  },
  run: async (task, tk, signal) => {
    if (task.source.kind !== "issue") {
      return {
        status: "failed",
        errorSummary: "issue-comment-reply requires an issue source",
      };
    }

    signal.throwIfAborted();
    await using ws = await tk.workspace.prepareObserve(task);
    void ws;

    signal.throwIfAborted();
    const ctx = await tk.github.fetchContext(task);
    if (ctx.kind !== "issue") {
      return {
        status: "failed",
        errorSummary: "issue-comment-reply requires issue context",
      };
    }

    signal.throwIfAborted();
    const result = await tk.ai.run({
      prompt: [
        { kind: "file", path: "_common/work-rules" },
        { kind: "file", path: "_common/tone" },
        { kind: "file", path: "_common/engineering-stance" },
        { kind: "file", path: "personas/reply" },
        { kind: "literal", text: header(task, ctx) },
        { kind: "file", path: "modes/reply-structured" },
        { kind: "file", path: "_common/omgr-docs" },
        { kind: "context", key: "issue-body" },
        { kind: "context", key: "issue-comments" },
        { kind: "context", key: "linked-refs" },
        { kind: "user", text: task.additionalInstructions ?? "" },
      ],
      allowedTools: COLLECT_ONLY_ALLOWED,
      timeoutMs: TIMEOUT_MS,
      outputSchema: ISSUE_COMMENT_REPLY_OUTPUT_SCHEMA,
    });

    if (result.kind !== "succeeded") {
      return mapAiFailure(result);
    }

    let envelope;
    try {
      envelope = parseIssueCommentReplyEnvelope(result.stdout, task.source.number);
    } catch (error) {
      return {
        status: "failed",
        errorSummary: error instanceof Error ? error.message : String(error),
      };
    }

    const receipts: string[] = [];
    for (const action of envelope.additionalActions) {
      signal.throwIfAborted();
      try {
        switch (action.kind) {
          case "create_issue": {
            const created = await tk.github.createIssue(
              task.repo,
              action.title,
              action.body,
            );
            receipts.push(formatSucceededActionReceipt(action, created));
            break;
          }
          case "close_issue":
            await tk.github.closeIssue(task.repo, action.issueNumber);
            receipts.push(formatSucceededActionReceipt(action));
            break;
          case "comment":
            if (action.targetKind === "issue") {
              await tk.github.postIssueComment(
                task.repo,
                action.targetNumber,
                action.body,
              );
            } else {
              await tk.github.postPrComment(
                task.repo,
                action.targetNumber,
                action.body,
              );
            }
            receipts.push(formatSucceededActionReceipt(action));
            break;
        }
      } catch (error) {
        receipts.push(formatFailedActionReceipt(action, error));
      }
    }

    const appendix = renderAdditionalActionReceipts(receipts);
    const finalReply =
      appendix.length > 0
        ? `${envelope.replyComment}\n\n${appendix}`
        : envelope.replyComment;

    try {
      await tk.github.postIssueComment(task.repo, task.source.number, finalReply);
    } catch (error) {
      return {
        status: "failed",
        errorSummary: `issue-comment-reply: failed to post source reply: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    return ok();
  },
};
