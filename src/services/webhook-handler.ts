import type { RepoRef } from "../domain/task.js";
import type { GitHubClient } from "../domain/ports/github-client.js";
import type { DeliveryDedupCache } from "../infra/webhook/delivery-dedup.js";
import { verifyHubSignature } from "../infra/webhook/hmac-verifier.js";
import type {
  DispatchAction,
  DispatchedEvent,
  EventDispatcher,
} from "./event-dispatcher.js";
import type { EnqueueService } from "./enqueue-service.js";

export interface WebhookHandlerDependencies {
  secret: string;
  dispatcher: EventDispatcher;
  enqueueService: Pick<EnqueueService, "enqueue">;
  githubClient: Pick<
    GitHubClient,
    "getPullRequestState" | "postIssueComment" | "postPullRequestComment"
  >;
  deliveryDedup: DeliveryDedupCache;
}

export interface WebhookHandlerResult {
  status: number;
  body?: string;
}

type Headers = Record<string, string | string[] | undefined>;

interface WebhookPayloadCommon {
  repository?: {
    owner: { login: string };
    name: string;
  };
  sender?: {
    id: number;
    login: string;
    type?: string;
  };
}

interface IssuesPayload extends WebhookPayloadCommon {
  action: string;
  issue: {
    number: number;
    labels?: Array<string | { name: string }>;
    pull_request?: unknown;
  };
}

interface IssueCommentPayload extends WebhookPayloadCommon {
  action: string;
  issue: {
    number: number;
    pull_request?: unknown;
  };
  comment: {
    body: string;
  };
}

interface PullRequestReviewCommentPayload extends WebhookPayloadCommon {
  action: string;
  pull_request: {
    number: number;
    state: "open" | "closed";
    merged?: boolean;
    head: {
      ref: string;
      repo: { full_name: string } | null;
    };
  };
  comment: {
    body: string;
  };
}

export class WebhookHandler {
  constructor(private readonly deps: WebhookHandlerDependencies) {}

  async handle(rawBody: Buffer, headers: Headers): Promise<WebhookHandlerResult> {
    const signature = readHeader(headers, "x-hub-signature-256");
    const deliveryId = readHeader(headers, "x-github-delivery") ?? "-";
    const eventName = readHeader(headers, "x-github-event") ?? "-";

    if (!verifyHubSignature(this.deps.secret, rawBody, signature)) {
      console.warn(
        `[webhook] reject delivery=${deliveryId} event=${eventName} reason=invalid-signature`,
      );
      return { status: 401, body: "invalid signature" };
    }

    if (deliveryId !== "-" && this.deps.deliveryDedup.markSeen(deliveryId)) {
      console.log(
        `[webhook] duplicate delivery=${deliveryId} event=${eventName}`,
      );
      return { status: 200, body: "duplicate" };
    }

    if (eventName === "-") {
      console.warn(
        `[webhook] reject delivery=${deliveryId} reason=missing-event-header`,
      );
      return { status: 400, body: "missing X-GitHub-Event" };
    }

    let payload: unknown;

    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      console.warn(
        `[webhook] reject delivery=${deliveryId} event=${eventName} reason=invalid-json`,
      );
      return { status: 400, body: "invalid JSON" };
    }

    console.log(
      `[webhook] received delivery=${deliveryId} event=${eventName} ${describeSender(payload)}`,
    );

    const dispatched = await this.toDispatchedEvent(eventName, payload);

    if (dispatched === null) {
      console.log(
        `[webhook] ignored delivery=${deliveryId} event=${eventName} reason=unsupported-or-skipped`,
      );
      return { status: 200, body: "ignored" };
    }

    const action = this.deps.dispatcher.dispatch(dispatched);

    this.logAction(deliveryId, eventName, action);

    await this.executeAction(action);

    return { status: 200, body: action.kind };
  }

  private logAction(
    deliveryId: string,
    eventName: string,
    action: DispatchAction,
  ): void {
    if (action.kind === "enqueue") {
      console.log(
        `[webhook] enqueue delivery=${deliveryId} event=${eventName} instruction=${action.instructionId} agent=${action.agent} repo=${action.repo.owner}/${action.repo.name} ${action.source.kind}=${action.source.number} requestedBy=${action.requestedBy}`,
      );
      return;
    }

    if (action.kind === "reject") {
      console.warn(
        `[webhook] reject delivery=${deliveryId} event=${eventName} reason=${action.reason}`,
      );
      return;
    }

    console.log(
      `[webhook] ignore delivery=${deliveryId} event=${eventName} reason=${action.reason}`,
    );
  }

  private async toDispatchedEvent(
    eventName: string,
    payload: unknown,
  ): Promise<DispatchedEvent | null> {
    if (typeof payload !== "object" || payload === null) {
      return null;
    }

    if (eventName === "issues") {
      const event = payload as IssuesPayload;

      if (event.action !== "opened") {
        return null;
      }

      const repo = readRepo(event);
      const sender = readSender(event);

      if (repo === null || sender === null) {
        return null;
      }

      return {
        kind: "issue_opened",
        repo,
        issue: {
          number: event.issue.number,
          labels: (event.issue.labels ?? []).map((label) =>
            typeof label === "string" ? label : label.name,
          ),
        },
        sender,
      };
    }

    if (eventName === "issue_comment") {
      const event = payload as IssueCommentPayload;

      if (event.action !== "created") {
        return null;
      }

      const repo = readRepo(event);
      const sender = readSender(event);

      if (repo === null || sender === null) {
        return null;
      }

      if (event.issue.pull_request !== undefined) {
        const pr = await this.deps.githubClient.getPullRequestState(
          repo,
          event.issue.number,
        );

        return {
          kind: "pr_comment",
          repo,
          pr,
          comment: { body: event.comment.body },
          sender,
        };
      }

      return {
        kind: "issue_comment",
        repo,
        issue: { number: event.issue.number },
        comment: { body: event.comment.body },
        sender,
      };
    }

    if (eventName === "pull_request_review_comment") {
      const event = payload as PullRequestReviewCommentPayload;

      if (event.action !== "created") {
        return null;
      }

      const repo = readRepo(event);
      const sender = readSender(event);

      if (repo === null || sender === null) {
        return null;
      }

      const baseFullName = `${repo.owner}/${repo.name}`;
      const headFullName = event.pull_request.head.repo?.full_name ?? null;

      return {
        kind: "pr_comment",
        repo,
        pr: {
          number: event.pull_request.number,
          isFork:
            headFullName !== null && headFullName !== baseFullName,
          state: event.pull_request.state,
          merged: event.pull_request.merged ?? false,
          headRef:
            event.pull_request.head.repo === null
              ? null
              : event.pull_request.head.ref,
        },
        comment: { body: event.comment.body },
        sender,
      };
    }

    return null;
  }

  private async executeAction(action: DispatchAction): Promise<void> {
    if (action.kind === "ignore") {
      return;
    }

    if (action.kind === "reject") {
      await this.deps.githubClient.postIssueComment(
        action.comment.repo,
        action.comment.issueNumber,
        action.comment.body,
      );
      return;
    }

    await this.deps.enqueueService.enqueue({
      repo: action.repo,
      source: action.source,
      instructionId: action.instructionId,
      agent: action.agent,
      requestedBy: action.requestedBy,
      ...(action.additionalInstructions !== undefined
        ? { additionalInstructions: action.additionalInstructions }
        : {}),
    });
  }
}

function readHeader(headers: Headers, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];

  if (value === undefined) {
    return undefined;
  }

  return Array.isArray(value) ? value[0] : value;
}

function readRepo(event: WebhookPayloadCommon): RepoRef | null {
  if (event.repository === undefined) {
    return null;
  }

  return {
    owner: event.repository.owner.login,
    name: event.repository.name,
  };
}

function readSender(
  event: WebhookPayloadCommon,
): { id: number; login: string } | null {
  if (event.sender === undefined) {
    return null;
  }

  return { id: event.sender.id, login: event.sender.login };
}

function describeSender(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    return "sender=- repo=-";
  }

  const event = payload as WebhookPayloadCommon & {
    action?: string;
  };
  const repo =
    event.repository !== undefined
      ? `${event.repository.owner.login}/${event.repository.name}`
      : "-";
  const sender = event.sender !== undefined ? event.sender.login : "-";
  const action = event.action ?? "-";

  return `action=${action} sender=${sender} repo=${repo}`;
}
