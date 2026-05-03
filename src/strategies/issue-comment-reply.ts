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

// Source reply has to land on the original issue to keep the thread from
// going silent after side effects already executed. Retry a small fixed
// number of times before giving up so a transient GitHub API hiccup does
// not strand the receipts in the task log alone.
const SOURCE_REPLY_MAX_ATTEMPTS = 3;

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

    let sourceReplyError: unknown;
    for (let attempt = 1; attempt <= SOURCE_REPLY_MAX_ATTEMPTS; attempt++) {
      signal.throwIfAborted();
      try {
        await tk.github.postIssueComment(
          task.repo,
          task.source.number,
          finalReply,
        );
        sourceReplyError = undefined;
        if (attempt > 1) {
          await tk.log.write(
            `issue-comment-reply: source reply posted on attempt ${attempt}/${SOURCE_REPLY_MAX_ATTEMPTS}`,
          );
        }
        break;
      } catch (error) {
        sourceReplyError = error;
        await tk.log.write(
          `issue-comment-reply: source reply attempt ${attempt}/${SOURCE_REPLY_MAX_ATTEMPTS} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (sourceReplyError !== undefined) {
      // Side effects in `additionalActions` are already on GitHub. Persist
      // the intended reply body (with receipts) to the task log so the
      // owner can recover the would-have-been-posted reply manually.
      await tk.log.write(
        `issue-comment-reply: giving up after ${SOURCE_REPLY_MAX_ATTEMPTS} attempts; intended reply body follows so executed side effects are not silently lost:\n${finalReply}`,
      );
      return {
        status: "failed",
        errorSummary: `issue-comment-reply: failed to post source reply after ${SOURCE_REPLY_MAX_ATTEMPTS} attempts: ${
          sourceReplyError instanceof Error
            ? sourceReplyError.message
            : String(sourceReplyError)
        }`,
      };
    }

    return ok();
  },
};
