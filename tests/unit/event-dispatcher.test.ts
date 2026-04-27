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
    agentRegistry: {
      has: (name: string) => name === "claude",
      getDefaultAgent: () => "claude",
    },
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
      comment: { body: "/claude" },
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
    assert.equal(action.agent, "claude");
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

  test("maps /claude on an issue to issue-comment-reply", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "issue_comment",
      repo,
      issue: { number: 12 },
      comment: { body: "/claude" },
      sender: { id: 100, login: "alice" },
    });

    assert.equal(action.kind, "enqueue");
    if (action.kind !== "enqueue") return;
    assert.equal(action.instructionId, "issue-comment-reply");
  });

  test("maps /claude implement on an issue to issue-implement", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "issue_comment",
      repo,
      issue: { number: 12 },
      comment: { body: "/claude implement add tests" },
      sender: { id: 100, login: "alice" },
    });

    assert.equal(action.kind, "enqueue");
    if (action.kind !== "enqueue") return;
    assert.equal(action.instructionId, "issue-implement");
    assert.equal(action.additionalInstructions, "add tests");
  });

  test("maps /claude on a PR to pr-review-comment", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "pr_comment",
      repo,
      pr: pr({ number: 52 }),
      comment: { body: "/claude" },
      sender: { id: 100, login: "alice" },
    });

    assert.equal(action.kind, "enqueue");
    if (action.kind !== "enqueue") return;
    assert.equal(action.instructionId, "pr-review-comment");
    assert.deepEqual(action.source, { kind: "pull_request", number: 52 });
  });

  test("maps /claude implement on a PR to pr-implement", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "pr_comment",
      repo,
      pr: pr({ number: 52 }),
      comment: { body: "/claude implement" },
      sender: { id: 100, login: "alice" },
    });

    assert.equal(action.kind, "enqueue");
    if (action.kind !== "enqueue") return;
    assert.equal(action.instructionId, "pr-implement");
  });

  test("maps /claude Implement (capitalized) on a PR to pr-implement", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "pr_comment",
      repo,
      pr: pr({ number: 52 }),
      comment: { body: "/claude Implement" },
      sender: { id: 100, login: "alice" },
    });

    assert.equal(action.kind, "enqueue");
    if (action.kind !== "enqueue") return;
    assert.equal(action.instructionId, "pr-implement");
  });

  test("rejects /claude implement on a fork PR with a comment", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "pr_comment",
      repo,
      pr: pr({ number: 52, isFork: true }),
      comment: { body: "/claude implement" },
      sender: { id: 100, login: "alice" },
    });

    assert.equal(action.kind, "reject");
    if (action.kind !== "reject") return;
    assert.match(action.comment.body, /forks are not supported/);
  });

  test("rejects /claude implement on a merged PR", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "pr_comment",
      repo,
      pr: pr({ number: 52, merged: true }),
      comment: { body: "/claude implement" },
      sender: { id: 100, login: "alice" },
    });

    assert.equal(action.kind, "reject");
    if (action.kind !== "reject") return;
    assert.match(action.comment.body, /already merged/);
  });

  test("rejects /claude implement on a closed PR", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "pr_comment",
      repo,
      pr: pr({ number: 52, state: "closed" }),
      comment: { body: "/claude implement" },
      sender: { id: 100, login: "alice" },
    });

    assert.equal(action.kind, "reject");
    if (action.kind !== "reject") return;
    assert.match(action.comment.body, /closed/);
  });

  test("rejects /claude implement when head branch is gone", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "pr_comment",
      repo,
      pr: pr({ number: 52, headRef: null }),
      comment: { body: "/claude implement" },
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
      comment: { body: "Just a normal comment" },
      sender: { id: 100, login: "alice" },
    });

    assert.equal(action.kind, "ignore");
  });

  test("ignores commands that target an unregistered agent", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "issue_comment",
      repo,
      issue: { number: 12 },
      comment: { body: "/codex implement" },
      sender: { id: 100, login: "alice" },
    });

    assert.equal(action.kind, "ignore");
    if (action.kind !== "ignore") return;
    assert.match(action.reason, /not registered/);
  });

  test("ignores issue.opened from a sender outside the allowlist", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "issue_opened",
      repo,
      issue: { number: 1, labels: [] },
      sender: { id: 999, login: "stranger" },
    });

    assert.equal(action.kind, "ignore");
    if (action.kind !== "ignore") return;
    assert.match(action.reason, /not in allowlist/);
    assert.match(action.reason, /999/);
    assert.match(action.reason, /stranger/);
  });

  test("ignores issue_comment from a sender outside the allowlist even with a valid command", () => {
    const dispatcher = makeDispatcher();

    const action = dispatcher.dispatch({
      kind: "issue_comment",
      repo,
      issue: { number: 1 },
      comment: { body: "/claude implement" },
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
      comment: { body: "/claude implement" },
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
      comment: { body: "/claude" },
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
