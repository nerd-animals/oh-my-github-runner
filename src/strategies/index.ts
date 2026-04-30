import { issueCommentReplyStrategy } from "./issue-comment-reply.js";
import { issueImplementStrategy } from "./issue-implement.js";
import { issueInitialReviewStrategy } from "./issue-initial-review/index.js";
import { prImplementStrategy } from "./pr-implement.js";
import { prReviewCommentStrategy } from "./pr-review-comment.js";
import type { Strategy } from "./types.js";

export const strategies: ReadonlyMap<string, Strategy> = new Map<
  string,
  Strategy
>([
  ["issue-initial-review", issueInitialReviewStrategy],
  ["issue-comment-reply", issueCommentReplyStrategy],
  ["pr-review-comment", prReviewCommentStrategy],
  ["issue-implement", issueImplementStrategy],
  ["pr-implement", prImplementStrategy],
]);

export function getStrategy(instructionId: string): Strategy {
  const strategy = strategies.get(instructionId);
  if (strategy === undefined) {
    throw new Error(`Unknown instructionId: ${instructionId}`);
  }
  return strategy;
}

export function hasStrategy(instructionId: string): boolean {
  return strategies.has(instructionId);
}

export type { Strategy } from "./types.js";
