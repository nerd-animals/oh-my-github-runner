import { issueImplementStrategy } from "./issue-implement.js";
import { issueResponseStrategy } from "./issue-response.js";
import { prImplementStrategy } from "./pr-implement.js";
import { prReviewCommentStrategy } from "./pr-review-comment.js";
import type { Strategy } from "./types.js";

// Map key MUST equal `task.instructionId` produced at enqueue.
//
// `issue-initial-review` and `issue-comment-reply` share one Strategy
// instance: both flows produce a single envelope (replyComment +
// additionalActions) on an issue, and the only meaningful difference
// (presence of prior comments) lives in the fetched context, not in
// strategy code.
export const strategies: ReadonlyMap<string, Strategy> = new Map<
  string,
  Strategy
>([
  ["issue-initial-review", issueResponseStrategy],
  ["issue-comment-reply", issueResponseStrategy],
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
