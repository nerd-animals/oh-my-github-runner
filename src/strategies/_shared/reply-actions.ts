export interface CreateIssueAction {
  kind: "create_issue";
  title: string;
  body: string;
}

export interface CloseIssueAction {
  kind: "close_issue";
  issueNumber: number;
}

export interface CommentAction {
  kind: "comment";
  targetKind: "issue" | "pull_request";
  targetNumber: number;
  body: string;
}

export type ReplyAdditionalAction =
  | CreateIssueAction
  | CloseIssueAction
  | CommentAction;

export interface IssueCommentReplyEnvelope {
  replyComment: string;
  additionalActions: ReplyAdditionalAction[];
  reasoning: string;
}

export const ISSUE_COMMENT_REPLY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["replyComment", "additionalActions", "reasoning"],
  properties: {
    replyComment: {
      type: "string",
      minLength: 1,
    },
    additionalActions: {
      type: "array",
      items: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "title", "body"],
            properties: {
              kind: { type: "string", enum: ["create_issue"] },
              title: { type: "string", minLength: 1 },
              body: { type: "string", minLength: 1 },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "issueNumber"],
            properties: {
              kind: { type: "string", enum: ["close_issue"] },
              issueNumber: { type: "integer", minimum: 1 },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "targetKind", "targetNumber", "body"],
            properties: {
              kind: { type: "string", enum: ["comment"] },
              targetKind: {
                type: "string",
                enum: ["issue", "pull_request"],
              },
              targetNumber: { type: "integer", minimum: 1 },
              body: { type: "string", minLength: 1 },
            },
          },
        ],
      },
    },
    reasoning: {
      type: "string",
      minLength: 1,
    },
  },
} as const;

export function parseIssueCommentReplyEnvelope(
  stdout: string,
  sourceIssueNumber: number,
): IssueCommentReplyEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `issue-comment-reply: failed to parse structured output as JSON: ${errorMessage(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("issue-comment-reply: structured output must be a JSON object");
  }

  const replyComment = readNonEmptyString(parsed.replyComment, "replyComment");
  const reasoning = readNonEmptyString(parsed.reasoning, "reasoning");
  const rawActions = parsed.additionalActions;

  if (!Array.isArray(rawActions)) {
    throw new Error("issue-comment-reply: additionalActions must be an array");
  }

  const additionalActions = rawActions.map((entry, index) =>
    parseAdditionalAction(entry, index, sourceIssueNumber),
  );

  return { replyComment, additionalActions, reasoning };
}

export function renderAdditionalActionReceipts(
  receipts: readonly string[],
): string {
  if (receipts.length === 0) {
    return "";
  }
  return ["Additional actions:", ...receipts.map((line) => `- ${line}`)].join(
    "\n",
  );
}

export function formatSucceededActionReceipt(
  action: ReplyAdditionalAction,
  result?: { number: number },
): string {
  switch (action.kind) {
    case "create_issue":
      return `Opened follow-up issue #${result?.number ?? "?"}: ${action.title}`;
    case "close_issue":
      return `Closed issue #${action.issueNumber}.`;
    case "comment":
      return `Commented on ${displayTarget(action.targetKind)} #${action.targetNumber}.`;
  }
}

export function formatFailedActionReceipt(
  action: ReplyAdditionalAction,
  error: unknown,
): string {
  const detail = errorMessage(error);
  switch (action.kind) {
    case "create_issue":
      return `Failed to open follow-up issue "${action.title}": ${detail}`;
    case "close_issue":
      return `Failed to close issue #${action.issueNumber}: ${detail}`;
    case "comment":
      return `Failed to comment on ${displayTarget(action.targetKind)} #${action.targetNumber}: ${detail}`;
  }
}

function parseAdditionalAction(
  value: unknown,
  index: number,
  sourceIssueNumber: number,
): ReplyAdditionalAction {
  if (!isRecord(value)) {
    throw new Error(
      `issue-comment-reply: additionalActions[${index}] must be an object`,
    );
  }

  const kind = value.kind;
  if (kind === "create_issue") {
    return {
      kind,
      title: readNonEmptyString(value.title, `additionalActions[${index}].title`),
      body: readNonEmptyString(value.body, `additionalActions[${index}].body`),
    };
  }

  if (kind === "close_issue") {
    return {
      kind,
      issueNumber: readPositiveInteger(
        value.issueNumber,
        `additionalActions[${index}].issueNumber`,
      ),
    };
  }

  if (kind === "comment") {
    const targetKind = readTargetKind(
      value.targetKind,
      `additionalActions[${index}].targetKind`,
    );
    const targetNumber = readPositiveInteger(
      value.targetNumber,
      `additionalActions[${index}].targetNumber`,
    );
    if (targetKind === "issue" && targetNumber === sourceIssueNumber) {
      throw new Error(
        "issue-comment-reply: additionalActions.comment cannot target the source issue; use replyComment instead",
      );
    }
    return {
      kind,
      targetKind,
      targetNumber,
      body: readNonEmptyString(value.body, `additionalActions[${index}].body`),
    };
  }

  throw new Error(
    `issue-comment-reply: unsupported additional action kind at index ${index}`,
  );
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`issue-comment-reply: ${field} must be a non-empty string`);
  }
  return value.trim();
}

function readPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`issue-comment-reply: ${field} must be a positive integer`);
  }
  return value;
}

function readTargetKind(
  value: unknown,
  field: string,
): "issue" | "pull_request" {
  if (value === "issue" || value === "pull_request") {
    return value;
  }
  throw new Error(
    `issue-comment-reply: ${field} must be either 'issue' or 'pull_request'`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function displayTarget(targetKind: "issue" | "pull_request"): string {
  return targetKind === "pull_request" ? "pull request" : "issue";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
