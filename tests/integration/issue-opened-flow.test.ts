import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { TaskRecord } from "../../src/domain/task.js";
import { FileInstructionLoader } from "../../src/infra/instructions/instruction-loader.js";
import { FileQueueStore } from "../../src/infra/queue/file-queue-store.js";
import { DeliveryDedupCache } from "../../src/infra/webhook/delivery-dedup.js";
import { computeHubSignature } from "../../src/infra/webhook/hmac-verifier.js";
import { EnqueueService } from "../../src/services/enqueue-service.js";
import { EventDispatcher } from "../../src/services/event-dispatcher.js";
import { RepoAllowlist } from "../../src/services/repo-allowlist.js";
import { WebhookHandler } from "../../src/services/webhook-handler.js";

const REPO_OWNER = "nerd-animals";
const REPO_NAME = "oh-my-github-runner";

describe("integration: issue-opened webhook produces an enqueued task", () => {
  test("verified payload enqueues issue-initial-review on the file queue", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ohmy-e2e-"));

    try {
      const queueDir = join(tempDir, "var", "queue");
      const queueStore = new FileQueueStore({ dataDir: queueDir });
      const instructionLoader = new FileInstructionLoader(
        join(process.cwd(), "definitions", "instructions"),
      );
      const repoAllowlist = new RepoAllowlist([
        `${REPO_OWNER}/${REPO_NAME}`,
      ]);
      const enqueueService = new EnqueueService({
        instructionLoader,
        queueStore,
        repoAllowlist,
      });

      const dispatcher = new EventDispatcher({
        agentRegistry: {
          has: (name) => name === "claude",
          getDefaultAgent: () => "claude",
        },
        botUserId: 9999,
      });

      const handler = new WebhookHandler({
        secret: "integration-secret",
        dispatcher,
        enqueueService,
        githubClient: {
          getPullRequestState: async () => ({
            number: 0,
            isFork: false,
            state: "open",
            merged: false,
            headRef: null,
          }),
          postIssueComment: async () => {},
          postPullRequestComment: async () => {},
        },
        deliveryDedup: new DeliveryDedupCache({ ttlMs: 60_000 }),
      });

      const payload = {
        action: "opened",
        issue: { number: 42, labels: [] },
        repository: {
          owner: { login: REPO_OWNER },
          name: REPO_NAME,
        },
        sender: { id: 100, login: "alice" },
      };
      const body = Buffer.from(JSON.stringify(payload));
      const signature = computeHubSignature("integration-secret", body);

      const result = await handler.handle(body, {
        "x-hub-signature-256": signature,
        "x-github-event": "issues",
        "x-github-delivery": "delivery-e2e-1",
      });

      assert.equal(result.status, 200);
      assert.equal(result.body, "enqueue");

      const tasksFile = join(queueDir, "tasks.json");
      const raw = await readFile(tasksFile, "utf8");
      const tasks = JSON.parse(raw) as TaskRecord[];

      assert.equal(tasks.length, 1);
      const task = tasks[0]!;
      assert.equal(task.instructionId, "issue-initial-review");
      assert.equal(task.agent, "claude");
      assert.equal(task.status, "queued");
      assert.deepEqual(task.repo, {
        owner: REPO_OWNER,
        name: REPO_NAME,
      });
      assert.deepEqual(task.source, { kind: "issue", number: 42 });
      assert.equal(task.requestedBy, "alice");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects when the repo is not on the allowlist", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ohmy-e2e-"));

    try {
      const queueStore = new FileQueueStore({
        dataDir: join(tempDir, "var", "queue"),
      });
      const enqueueService = new EnqueueService({
        instructionLoader: new FileInstructionLoader(
          join(process.cwd(), "definitions", "instructions"),
        ),
        queueStore,
        repoAllowlist: new RepoAllowlist([`${REPO_OWNER}/${REPO_NAME}`]),
      });
      const dispatcher = new EventDispatcher({
        agentRegistry: {
          has: () => true,
          getDefaultAgent: () => "claude",
        },
        botUserId: 9999,
      });
      const handler = new WebhookHandler({
        secret: "integration-secret",
        dispatcher,
        enqueueService,
        githubClient: {
          getPullRequestState: async () => ({
            number: 0,
            isFork: false,
            state: "open",
            merged: false,
            headRef: null,
          }),
          postIssueComment: async () => {},
          postPullRequestComment: async () => {},
        },
        deliveryDedup: new DeliveryDedupCache(),
      });

      const payload = {
        action: "opened",
        issue: { number: 1, labels: [] },
        repository: {
          owner: { login: "rogue" },
          name: "spam",
        },
        sender: { id: 100, login: "alice" },
      };
      const body = Buffer.from(JSON.stringify(payload));
      const signature = computeHubSignature("integration-secret", body);

      await assert.rejects(
        handler.handle(body, {
          "x-hub-signature-256": signature,
          "x-github-event": "issues",
          "x-github-delivery": "delivery-rogue",
        }),
        /not in the allowlist/,
      );

      const tasks = await queueStore.listTasks();
      assert.equal(tasks.length, 0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
