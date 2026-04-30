import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DeliveryDedupCache } from "../../src/infra/webhook/delivery-dedup.js";
import { computeHubSignature } from "../../src/infra/webhook/hmac-verifier.js";
import { EventDispatcher } from "../../src/services/event-dispatcher.js";
import { WebhookHandler } from "../../src/services/webhook-handler.js";
import type { QueueTaskInput } from "../../src/domain/queue-task.js";

const secret = "test-secret";
const botUserId = 9999;

interface HarnessOptions {
  enqueueImpl?: (input: QueueTaskInput) => Promise<void> | void;
  postCommentImpl?: (
    repo: { owner: string; name: string },
    issueNumber: number,
    body: string,
  ) => Promise<void> | void;
  getPullRequestStateImpl?: (
    repo: { owner: string; name: string },
    number: number,
  ) => Promise<{
    number: number;
    isFork: boolean;
    state: "open" | "closed";
    merged: boolean;
    headRef: string | null;
  }>;
  generateTaskId?: () => string;
}

interface Harness {
  handler: WebhookHandler;
  enqueued: QueueTaskInput[];
  postedComments: Array<{ issueNumber: number; body: string }>;
  updatedComments: Array<{ commentId: number; body: string }>;
  reactions: Array<{
    target:
      | { kind: "issue"; issueNumber: number }
      | { kind: "comment"; commentId: number };
    content: string;
  }>;
}

function buildHarness(options: HarnessOptions = {}): Harness {
  const enqueued: QueueTaskInput[] = [];
  const postedComments: Array<{ issueNumber: number; body: string }> = [];
  const updatedComments: Array<{ commentId: number; body: string }> = [];
  const reactions: Harness["reactions"] = [];
  let nextCommentId = 1000;

  const dispatcher = new EventDispatcher({
    botUserId,
    allowedSenderIds: new Set([1, 100, 200]),
  });

  const handler = new WebhookHandler({
    secret,
    dispatcher,
    enqueueService: {
      enqueue: async (input: QueueTaskInput) => {
        enqueued.push(input);
        await options.enqueueImpl?.(input);
        return {
          taskId: input.taskId ?? "task_test",
          repo: input.repo,
          source: input.source,
          instructionId: input.instructionId,
          status: "queued" as const,
          priority: "normal" as const,
          requestedBy: input.requestedBy,
          createdAt: new Date().toISOString(),
          ...(input.notifications !== undefined
            ? { notifications: input.notifications }
            : {}),
        };
      },
    },
    githubClient: {
      postIssueComment: async (repo, issueNumber, body) => {
        postedComments.push({ issueNumber, body });
        await options.postCommentImpl?.(repo, issueNumber, body);
        const commentId = nextCommentId++;
        return { commentId, body };
      },
      postPullRequestComment: async (_repo, _prNumber, body) => {
        const commentId = nextCommentId++;
        return { commentId, body };
      },
      updateIssueComment: async (_repo, commentId, body) => {
        updatedComments.push({ commentId, body });
      },
      addReaction: async (_repo, target, content) => {
        reactions.push({ target, content });
        return { reactionId: 5000 };
      },
      getPullRequestState:
        options.getPullRequestStateImpl ??
        (async (_repo, number) => ({
          number,
          isFork: false,
          state: "open",
          merged: false,
          headRef: "feature/x",
        })),
    },
    deliveryDedup: new DeliveryDedupCache({ ttlMs: 60_000 }),
    ...(options.generateTaskId !== undefined
      ? { generateTaskId: options.generateTaskId }
      : {}),
  });

  return { handler, enqueued, postedComments, updatedComments, reactions };
}

function signedHeaders(
  body: Buffer,
  eventName: string,
  delivery: string,
): Record<string, string> {
  return {
    "x-hub-signature-256": computeHubSignature(secret, body),
    "x-github-event": eventName,
    "x-github-delivery": delivery,
  };
}

const repoBlock = {
  repository: { owner: { login: "octo" }, name: "repo" },
};

describe("WebhookHandler", () => {
  test("rejects with 401 when HMAC is invalid", async () => {
    const { handler } = buildHarness();
    const body = Buffer.from(JSON.stringify({}));

    const result = await handler.handle(body, {
      "x-hub-signature-256": "sha256=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "x-github-event": "issues",
      "x-github-delivery": "abc",
    });

    assert.equal(result.status, 401);
  });

  test("collapses repeat deliveries by X-GitHub-Delivery", async () => {
    const harness = buildHarness();
    const payload = {
      ...repoBlock,
      action: "opened",
      issue: { number: 1, labels: [] },
      sender: { id: 100, login: "alice" },
    };
    const body = Buffer.from(JSON.stringify(payload));
    const headers = signedHeaders(body, "issues", "delivery-1");

    const first = await harness.handler.handle(body, headers);
    const second = await harness.handler.handle(body, headers);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body, "duplicate");
    assert.equal(harness.enqueued.length, 1);
  });

  test("issue.opened from our own bot still enqueues - bot self-loop check is bypassed for opens", async () => {
    const harness = buildHarness();
    const payload = {
      ...repoBlock,
      action: "opened",
      issue: { number: 1, labels: [] },
      sender: { id: botUserId, login: "our-bot[bot]", type: "Bot" },
    };
    const body = Buffer.from(JSON.stringify(payload));

    const result = await harness.handler.handle(
      body,
      signedHeaders(body, "issues", "delivery-bot"),
    );

    assert.equal(result.status, 200);
    assert.equal(harness.enqueued.length, 1);
    assert.equal(harness.enqueued[0]?.instructionId, "issue-initial-review");
  });

  test("issue_comment from our own bot is still ignored (self-loop guard remains for comments)", async () => {
    const harness = buildHarness();
    const payload = {
      ...repoBlock,
      action: "created",
      issue: { number: 1 },
      comment: { id: 1, body: "/omgr" },
      sender: { id: botUserId, login: "our-bot[bot]", type: "Bot" },
    };
    const body = Buffer.from(JSON.stringify(payload));

    const result = await harness.handler.handle(
      body,
      signedHeaders(body, "issue_comment", "delivery-bot-comment"),
    );

    assert.equal(result.status, 200);
    assert.equal(harness.enqueued.length, 0);
  });

  test("enqueues issue-initial-review for issues.opened", async () => {
    const harness = buildHarness();
    const payload = {
      ...repoBlock,
      action: "opened",
      issue: { number: 7, labels: [] },
      sender: { id: 100, login: "alice" },
    };
    const body = Buffer.from(JSON.stringify(payload));

    await harness.handler.handle(
      body,
      signedHeaders(body, "issues", "delivery-7"),
    );

    assert.equal(harness.enqueued.length, 1);
    assert.equal(harness.enqueued[0]?.instructionId, "issue-initial-review");
  });

  test("posts a rejection comment for fork PR /omgr implement", async () => {
    const harness = buildHarness({
      getPullRequestStateImpl: async (_repo, number) => ({
        number,
        isFork: true,
        state: "open",
        merged: false,
        headRef: "feature/x",
      }),
    });
    const payload = {
      ...repoBlock,
      action: "created",
      issue: { number: 52, pull_request: {} },
      comment: { id: 555, body: "/omgr implement" },
      sender: { id: 100, login: "alice" },
    };
    const body = Buffer.from(JSON.stringify(payload));

    await harness.handler.handle(
      body,
      signedHeaders(body, "issue_comment", "delivery-52"),
    );

    assert.equal(harness.enqueued.length, 0);
    assert.equal(harness.postedComments.length, 1);
    assert.match(
      harness.postedComments[0]?.body ?? "",
      /forks are not supported/,
    );
  });

  test("returns 400 for malformed JSON body", async () => {
    const { handler } = buildHarness();
    const body = Buffer.from("not json");

    const result = await handler.handle(body, signedHeaders(body, "issues", "x"));

    assert.equal(result.status, 400);
  });

  test("returns 200 ignored for an unsupported event type", async () => {
    const harness = buildHarness();
    const body = Buffer.from(JSON.stringify({ ...repoBlock }));

    const result = await harness.handler.handle(
      body,
      signedHeaders(body, "push", "delivery-push"),
    );

    assert.equal(result.status, 200);
    assert.equal(result.body, "ignored");
    assert.equal(harness.enqueued.length, 0);
  });

  test("posts a sticky comment with the task id and adds ?? reaction on issues.opened", async () => {
    const harness = buildHarness({
      generateTaskId: () => "task_fixed_123",
    });
    const payload = {
      ...repoBlock,
      action: "opened",
      issue: { number: 7, labels: [] },
      sender: { id: 100, login: "alice" },
    };
    const body = Buffer.from(JSON.stringify(payload));

    await harness.handler.handle(
      body,
      signedHeaders(body, "issues", "delivery-sticky-1"),
    );

    assert.equal(harness.postedComments.length, 1);
    const sticky = harness.postedComments[0]!;
    assert.equal(sticky.issueNumber, 7);
    assert.match(sticky.body, /<!-- omgr:task=task_fixed_123 -->/);
    assert.match(sticky.body, /Task queued/);
    assert.match(sticky.body, /task_fixed_123/);

    assert.equal(harness.reactions.length, 1);
    assert.deepEqual(harness.reactions[0]?.target, {
      kind: "issue",
      issueNumber: 7,
    });
    assert.equal(harness.reactions[0]?.content, "eyes");

    assert.equal(harness.enqueued.length, 1);
    assert.equal(harness.enqueued[0]?.taskId, "task_fixed_123");
    assert.equal(
      harness.enqueued[0]?.notifications?.sticky?.commentId,
      1000,
    );
    assert.equal(
      harness.enqueued[0]?.notifications?.sticky?.issueNumber,
      7,
    );
    assert.deepEqual(harness.enqueued[0]?.notifications?.trigger, {
      target: { kind: "issue", issueNumber: 7 },
      reactionId: 5000,
    });
  });

  test("posts a sticky comment and reacts to the comment on /omgr", async () => {
    const harness = buildHarness({
      generateTaskId: () => "task_fixed_456",
    });
    const payload = {
      ...repoBlock,
      action: "created",
      issue: { number: 12 },
      comment: { id: 9001, body: "/omgr" },
      sender: { id: 100, login: "alice" },
    };
    const body = Buffer.from(JSON.stringify(payload));

    await harness.handler.handle(
      body,
      signedHeaders(body, "issue_comment", "delivery-sticky-2"),
    );

    assert.equal(harness.postedComments.length, 1);
    assert.match(
      harness.postedComments[0]?.body ?? "",
      /<!-- omgr:task=task_fixed_456 -->/,
    );

    assert.equal(harness.reactions.length, 1);
    assert.deepEqual(harness.reactions[0]?.target, {
      kind: "comment",
      commentId: 9001,
    });
    assert.equal(harness.reactions[0]?.content, "eyes");
  });

  test("rejection path uses the sticky-rejection marker and a -1 reaction", async () => {
    const harness = buildHarness({
      getPullRequestStateImpl: async (_repo, number) => ({
        number,
        isFork: true,
        state: "open",
        merged: false,
        headRef: "feature/x",
      }),
    });
    const payload = {
      ...repoBlock,
      action: "created",
      issue: { number: 52, pull_request: {} },
      comment: { id: 7777, body: "/omgr implement" },
      sender: { id: 100, login: "alice" },
    };
    const body = Buffer.from(JSON.stringify(payload));

    await harness.handler.handle(
      body,
      signedHeaders(body, "issue_comment", "delivery-reject-sticky"),
    );

    assert.equal(harness.enqueued.length, 0);
    assert.equal(harness.postedComments.length, 1);
    assert.match(
      harness.postedComments[0]?.body ?? "",
      /<!-- omgr:rejected -->/,
    );
    assert.match(harness.postedComments[0]?.body ?? "", /Trigger rejected/);
    assert.match(
      harness.postedComments[0]?.body ?? "",
      /forks are not supported/,
    );

    assert.equal(harness.reactions.length, 1);
    assert.deepEqual(harness.reactions[0]?.target, {
      kind: "comment",
      commentId: 7777,
    });
    assert.equal(harness.reactions[0]?.content, "-1");
  });

  test("enqueue still proceeds when reaction API throws", async () => {
    const enqueued: QueueTaskInput[] = [];
    const dispatcher = new EventDispatcher({
      botUserId,
      allowedSenderIds: new Set([100]),
    });

    const handler = new WebhookHandler({
      secret,
      dispatcher,
      enqueueService: {
        enqueue: async (input) => {
          enqueued.push(input);
          return {
            taskId: input.taskId ?? "task_test",
            repo: input.repo,
            source: input.source,
            instructionId: input.instructionId,
            status: "queued" as const,
            priority: "normal" as const,
            requestedBy: input.requestedBy,
            createdAt: new Date().toISOString(),
          };
        },
      },
      githubClient: {
        postIssueComment: async () => ({ commentId: 1, body: "" }),
        postPullRequestComment: async () => ({ commentId: 1, body: "" }),
        updateIssueComment: async () => {},
        addReaction: async (): Promise<{ reactionId: number }> => {
          throw new Error("reactions API failure");
        },
        getPullRequestState: async (_repo, number) => ({
          number,
          isFork: false,
          state: "open" as const,
          merged: false,
          headRef: "feature/x",
        }),
      },
      deliveryDedup: new DeliveryDedupCache({ ttlMs: 60_000 }),
    });

    const payload = {
      ...repoBlock,
      action: "opened",
      issue: { number: 11, labels: [] },
      sender: { id: 100, login: "alice" },
    };
    const body = Buffer.from(JSON.stringify(payload));
    const result = await handler.handle(
      body,
      signedHeaders(body, "issues", "delivery-degraded"),
    );

    assert.equal(result.status, 200);
    assert.equal(enqueued.length, 1);
  });

  test("when enqueue throws, sticky comment is edited to reflect failure", async () => {
    const harness = buildHarness({
      generateTaskId: () => "task_fail_enqueue",
      enqueueImpl: () => {
        throw new Error("queue write failure");
      },
    });
    const payload = {
      ...repoBlock,
      action: "opened",
      issue: { number: 13, labels: [] },
      sender: { id: 100, login: "alice" },
    };
    const body = Buffer.from(JSON.stringify(payload));

    await assert.rejects(
      harness.handler.handle(
        body,
        signedHeaders(body, "issues", "delivery-fail-enqueue"),
      ),
      /queue write failure/,
    );

    assert.equal(harness.postedComments.length, 1);
    assert.equal(harness.updatedComments.length, 1);
    assert.match(
      harness.updatedComments[0]?.body ?? "",
      /failed to enqueue/i,
    );
    assert.match(
      harness.updatedComments[0]?.body ?? "",
      /task_fail_enqueue/,
    );
  });
});
