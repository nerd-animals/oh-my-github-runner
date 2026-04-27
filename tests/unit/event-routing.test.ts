import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_ROUTING_RULES,
  resolveInstructionId,
} from "../../src/domain/rules/event-routing.js";

describe("DEFAULT_ROUTING_RULES", () => {
  test("issue_opened resolves to issue-initial-review", () => {
    assert.equal(
      resolveInstructionId(DEFAULT_ROUTING_RULES, {
        eventKind: "issue_opened",
        verb: null,
      }),
      "issue-initial-review",
    );
  });

  test("issue_comment + implement resolves to issue-implement", () => {
    assert.equal(
      resolveInstructionId(DEFAULT_ROUTING_RULES, {
        eventKind: "issue_comment",
        verb: "implement",
      }),
      "issue-implement",
    );
  });

  test("issue_comment + null verb resolves to issue-comment-reply", () => {
    assert.equal(
      resolveInstructionId(DEFAULT_ROUTING_RULES, {
        eventKind: "issue_comment",
        verb: null,
      }),
      "issue-comment-reply",
    );
  });

  test("pr_comment + implement resolves to pr-implement", () => {
    assert.equal(
      resolveInstructionId(DEFAULT_ROUTING_RULES, {
        eventKind: "pr_comment",
        verb: "implement",
      }),
      "pr-implement",
    );
  });

  test("pr_comment + null verb resolves to pr-review-comment", () => {
    assert.equal(
      resolveInstructionId(DEFAULT_ROUTING_RULES, {
        eventKind: "pr_comment",
        verb: null,
      }),
      "pr-review-comment",
    );
  });

  test("returns null for an empty rule set", () => {
    assert.equal(
      resolveInstructionId([], {
        eventKind: "issue_opened",
        verb: null,
      }),
      null,
    );
  });
});
