import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EventDispatcher } from "../../src/services/event-dispatcher.js";
import type {
  DispatchedEvent,
  PullRequestState,
} from "../../src/services/event-dispatcher.js";

const repo = { owner: "octo", name: "repo" } as const;

function makeDispatcher(options?: {
  botUserId?: number;
  allowedSenderIds?: ReadonlySet<number>;
}): EventDispatcher {
  return new EventDispatcher({
    botUserId: options?.botUserId ?? 9999,
    allowedSenderIds: options?.allowedSenderIds ?? new Set([100, 101, 102]),
  });
}

function pr(overrides: Partial<PullRequestState> = {}): PullRequestState {
  return {
    number: 42,
    isFork: false,
    state: "open",
    merged: false,
    headRef: "feature/x",
    ...overrides,
  };
}

describe("EventDispatcher", () => {
  test("ignores events from our own bot", () => {
    const dispatcher = makeDispatcher({ botUserId: 1 });

    const action = dispatcher.dispatch({
      kind: "issue_comment",
      repo,
      issue: { number: 1 },
      comment: { id: 1, body: "/omgr" },
      sender: { id: 1, login: "our-bot" },
    });

    assert.equal(action.kind, "ignore");
  });

  test("auto-triggers issue-initial-review on issues.opened", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "issue_opened",
      repo,
      issue: { number: 7, labels: [] },
      sender: { id: 100, login: "alice" },
    });

    assert.equal(action.kind, "enqueue");
    if (action.kind !== "enqueue") return;
    assert.equal(action.instructionId, "issue-initial-review");
    assert.deepEqual(action.source, { kind: "issue", number: 7 });
    assert.equal(action.requestedBy, "alice");
  });

  test("suppresses auto-trigger when 'no-ai' label is set", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "issue_opened",
      repo,
      issue: { number: 7, labels: ["no-ai"] },
      sender: { id: 100, login: "alice" },
    });

    assert.equal(action.kind, "ignore");
  });

  test("maps /omgr on an issue to issue-comment-reply", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "issue_comment",
      repo,
      issue: { number: 12 },
      comment: { id: 1, body: "/omgr" },
      sender: { id: 100, login: "alice" },
    });

    assert.equal(action.kind, "enqueue");
    if (action.kind !== "enqueue") return;
    assert.equal(action.instructionId, "issue-comment-reply");
  });

  test("maps /omgr implement on an issue to issue-implement", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "issue_comment",
      repo,
      issue: { number: 12 },
      comment: { id: 3, body: "/omgr implement add tests" },
      sender: { id: 100, login: "alice" },
    });

    assert.equal(action.kind, "enqueue");
    if (action.kind !== "enqueue") return;
    assert.equal(action.instructionId, "issue-implement");
    assert.equal(action.additionalInstructions, "add tests");
  });

  test("maps /omgr on a PR to pr-review-comment", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "pr_comment",
      repo,
      pr: pr({ number: 52 }),
      comment: { id: 1, body: "/omgr" },
      sender: { id: 100, login: "alice" },
    });

    assert.equal(action.kind, "enqueue");
    if (action.kind !== "enqueue") return;
    assert.equal(action.instructionId, "pr-review-comment");
    assert.deepEqual(action.source, { kind: "pull_request", number: 52 });
  });

  test("maps /omgr implement on a PR to pr-implement", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "pr_comment",
      repo,
      pr: pr({ number: 52 }),
      comment: { id: 2, body: "/omgr implement" },
      sender: { id: 100, login: "alice" },
    });

    assert.equal(action.kind, "enqueue");
    if (action.kind !== "enqueue") return;
    assert.equal(action.instructionId, "pr-implement");
  });

  test("maps /omgr Implement (capitalized) on a PR to pr-implement", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "pr_comment",
      repo,
      pr: pr({ number: 52 }),
      comment: { id: 4, body: "/omgr Implement" },
      sender: { id: 100, login: "alice" },
    });

    assert.equal(action.kind, "enqueue");
    if (action.kind !== "enqueue") return;
    assert.equal(action.instructionId, "pr-implement");
  });

  test("rejects /omgr implement on a fork PR with a comment", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "pr_comment",
      repo,
      pr: pr({ number: 52, isFork: true }),
      comment: { id: 2, body: "/omgr implement" },
      sender: { id: 100, login: "alice" },
    });

    assert.equal(action.kind, "reject");
    if (action.kind !== "reject") return;
    assert.match(action.comment.body, /forks are not supported/);
  });

  test("rejects /omgr implement on a merged PR", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "pr_comment",
      repo,
      pr: pr({ number: 52, merged: true }),
      comment: { id: 2, body: "/omgr implement" },
      sender: { id: 100, login: "alice" },
    });

    assert.equal(action.kind, "reject");
    if (action.kind !== "reject") return;
    assert.match(action.comment.body, /already merged/);
  });

  test("rejects /omgr implement on a closed PR", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "pr_comment",
      repo,
      pr: pr({ number: 52, state: "closed" }),
      comment: { id: 2, body: "/omgr implement" },
      sender: { id: 100, login: "alice" },
    });

    assert.equal(action.kind, "reject");
    if (action.kind !== "reject") return;
    assert.match(action.comment.body, /closed/);
  });

  test("rejects /omgr implement when head branch is gone", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "pr_comment",
      repo,
      pr: pr({ number: 52, headRef: null }),
      comment: { id: 2, body: "/omgr implement" },
      sender: { id: 100, login: "alice" },
    });

    assert.equal(action.kind, "reject");
    if (action.kind !== "reject") return;
    assert.match(action.comment.body, /head branch has been deleted/);
  });

  test("ignores comments that do not contain a command", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "issue_comment",
      repo,
      issue: { number: 12 },
      comment: { id: 5, body: "Just a normal comment" },
      sender: { id: 100, login: "alice" },
    });

    assert.equal(action.kind, "ignore");
  });

  test("ignores commands that use a different trigger keyword", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "issue_comment",
      repo,
      issue: { number: 12 },
      comment: { id: 6, body: "/codex implement" },
      sender: { id: 100, login: "alice" },
    });

    assert.equal(action.kind, "ignore");
    if (action.kind !== "ignore") return;
    assert.match(action.reason, /no command in comment/);
  });

  test("issue.opened bypasses the allowlist (outside collaborators get an initial review)", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "issue_opened",
      repo,
      issue: { number: 1, labels: [] },
      sender: { id: 999, login: "stranger" },
    });

    assert.equal(action.kind, "enqueue");
    if (action.kind !== "enqueue") return;
    assert.equal(action.instructionId, "issue-initial-review");
    assert.equal(action.requestedBy, "stranger");
  });

  test("issue.opened bypasses the bot self-loop check (bot-authored issues still get reviewed)", () => {
    const dispatcher = makeDispatcher({ botUserId: 1 });

    const action = dispatcher.dispatch({
      kind: "issue_opened",
      repo,
      issue: { number: 1, labels: [] },
      sender: { id: 1, login: "our-bot" },
    });

    assert.equal(action.kind, "enqueue");
    if (action.kind !== "enqueue") return;
    assert.equal(action.instructionId, "issue-initial-review");
  });

  test("ignores issue_comment from a sender outside the allowlist even with a valid command", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "issue_comment",
      repo,
      issue: { number: 1 },
      comment: { id: 2, body: "/omgr implement" },
      sender: { id: 999, login: "stranger" },
    });

    assert.equal(action.kind, "ignore");
    if (action.kind !== "ignore") return;
    assert.match(action.reason, /not in allowlist/);
  });

  test("ignores pr_comment from a sender outside the allowlist", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "pr_comment",
      repo,
      pr: pr({ number: 5 }),
      comment: { id: 2, body: "/omgr implement" },
      sender: { id: 999, login: "stranger" },
    });

    assert.equal(action.kind, "ignore");
    if (action.kind !== "ignore") return;
    assert.match(action.reason, /not in allowlist/);
  });

  test("bot self-loop check fires before the allowlist check", () => {
    const dispatcher = makeDispatcher({
      botUserId: 1,
      allowedSenderIds: new Set([100]),
    });

    const action = dispatcher.dispatch({
      kind: "issue_comment",
      repo,
      issue: { number: 1 },
      comment: { id: 1, body: "/omgr" },
      sender: { id: 1, login: "our-bot" },
    });

    assert.equal(action.kind, "ignore");
    if (action.kind !== "ignore") return;
    assert.match(action.reason, /our app's bot/);
  });

  // Stable export reference (ensures the type alias survives)
  const _typeProbe: DispatchedEvent | undefined = undefined;
  void _typeProbe;
});
