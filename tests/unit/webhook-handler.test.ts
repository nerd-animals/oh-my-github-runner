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
}

interface Harness {
  handler: WebhookHandler;
  enqueued: QueueTaskInput[];
  postedComments: Array<{ issueNumber: number; body: string }>;
}

function buildHarness(options: HarnessOptions = {}): Harness {
  const enqueued: QueueTaskInput[] = [];
  const postedComments: Array<{ issueNumber: number; body: string }> = [];

  const dispatcher = new EventDispatcher({
    agentRegistry: {
      has: (name: string) => name === "claude",
      getDefaultAgent: () => "claude",
    },
    botUserId,
  });

  const handler = new WebhookHandler({
    secret,
    dispatcher,
    enqueueService: {
      enqueue: async (input: QueueTaskInput) => {
        enqueued.push(input);
        await options.enqueueImpl?.(input);
        return {
          taskId: "task_test",
          repo: input.repo,
          source: input.source,
          instructionId: input.instructionId,
          agent: input.agent,
          status: "queued" as const,
          priority: "normal" as const,
          requestedBy: input.requestedBy,
          createdAt: new Date().toISOString(),
        };
      },
    },
    githubClient: {
      postIssueComment: async (repo, issueNumber, body) => {
        postedComments.push({ issueNumber, body });
        await options.postCommentImpl?.(repo, issueNumber, body);
      },
      postPullRequestComment: async () => {},
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
  });

  return { handler, enqueued, postedComments };
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

  test("ignores events from our own bot (sender filter)", async () => {
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
    assert.equal(harness.enqueued[0]?.agent, "claude");
  });

  test("posts a rejection comment for fork PR /claude implement", async () => {
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
      comment: { body: "/claude implement" },
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
});
