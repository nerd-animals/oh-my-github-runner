import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import type {
  CreatePullRequestInput,
  GitHubComment,
  GitHubPullRequestSummary,
  GitHubSourceContext,
  LinkedRefEntry,
  LinkedRefKind,
  LinkedRefState,
  LinkedRefs,
} from "../../domain/github.js";
import type { InstructionContext } from "../../domain/instruction.js";
import type { RepoRef, SourceRef } from "../../domain/task.js";
import type {
  AppBotInfo,
  GitHubClient,
  IssueCommentRef,
  IssueLabelsInfo,
  PullRequestStateInfo,
  ReactionContent,
  ReactionTarget,
} from "../../domain/ports/github-client.js";
import { parseBodyMentions } from "../../domain/rules/body-mentions.js";
import { InstallationTokenCache } from "./installation-token-cache.js";

export interface GitHubAppClientOptions {
  appId: string;
  privateKeyPath: string;
  apiBaseUrl?: string;
  installationTokenCache?: InstallationTokenCache;
}

interface GitHubIssueResponse {
  title: string;
  body: string | null;
}

interface GitHubCommentResponse {
  user: {
    login: string;
  };
  body: string | null;
}

interface GitHubPullRequestResponse {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  merged?: boolean;
  head: {
    ref: string;
    repo: { full_name: string } | null;
  };
  base: {
    ref: string;
    repo: { full_name: string } | null;
  };
}

interface GitHubIssueLabelsResponse {
  labels: Array<string | { name: string }>;
}

interface GitHubAppResponse {
  slug: string;
}

interface GitHubUserResponse {
  id: number;
  login: string;
}

interface GitHubRepositoryResponse {
  default_branch: string;
}

interface GitHubInstallationResponse {
  id: number;
}

interface GitHubInstallationTokenResponse {
  token: string;
  expires_at: string;
}

export class GitHubAppClient implements GitHubClient {
  private readonly apiBaseUrl: string;
  private readonly privateKey: string;
  private readonly installationTokenCache: InstallationTokenCache;

  constructor(private readonly options: GitHubAppClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
    this.privateKey = readFileSync(options.privateKeyPath, "utf8");
    this.installationTokenCache =
      options.installationTokenCache ?? new InstallationTokenCache();
  }

  async getSourceContext(
    repo: RepoRef,
    source: SourceRef,
    instructionContext: InstructionContext,
  ): Promise<GitHubSourceContext> {
    if (source.kind === "issue") {
      const issue = await this.installationRequest<GitHubIssueResponse>(
        repo,
        "GET",
        `/repos/${repo.owner}/${repo.name}/issues/${source.number}`,
      );
      const comments =
        instructionContext.includeIssueComments === true
          ? await this.installationRequest<GitHubCommentResponse[]>(
              repo,
              "GET",
              `/repos/${repo.owner}/${repo.name}/issues/${source.number}/comments`,
            )
          : [];
      const linkedRefs = await this.fetchLinkedRefs(repo, source, issue.body ?? "");

      return {
        kind: "issue",
        title: issue.title,
        body:
          instructionContext.includeIssueBody === true ? (issue.body ?? "") : "",
        comments: comments.map(this.mapComment),
        linkedRefs,
      };
    }

    const pullRequest = await this.installationRequest<GitHubPullRequestResponse>(
      repo,
      "GET",
      `/repos/${repo.owner}/${repo.name}/pulls/${source.number}`,
    );
    const comments =
      instructionContext.includePrComments === true
        ? await this.installationRequest<GitHubCommentResponse[]>(
            repo,
            "GET",
            `/repos/${repo.owner}/${repo.name}/issues/${source.number}/comments`,
          )
        : [];
    const diff =
      instructionContext.includePrDiff === true
        ? await this.installationTextRequest(
            repo,
            "GET",
            `/repos/${repo.owner}/${repo.name}/pulls/${source.number}`,
            "application/vnd.github.v3.diff",
          )
        : "";
    const linkedRefs = await this.fetchLinkedRefs(
      repo,
      source,
      pullRequest.body ?? "",
    );

    return {
      kind: "pull_request",
      title: pullRequest.title,
      body:
        instructionContext.includePrBody === true
          ? (pullRequest.body ?? "")
          : "",
      comments: comments.map(this.mapComment),
      diff,
      baseRef: pullRequest.base.ref,
      headRef: pullRequest.head.ref,
      linkedRefs,
    };
  }

  async getPullRequestState(
    repo: RepoRef,
    pullRequestNumber: number,
  ): Promise<PullRequestStateInfo> {
    const pr = await this.installationRequest<GitHubPullRequestResponse>(
      repo,
      "GET",
      `/repos/${repo.owner}/${repo.name}/pulls/${pullRequestNumber}`,
    );

    const baseFullName = `${repo.owner}/${repo.name}`;
    const headFullName = pr.head.repo?.full_name ?? null;

    return {
      number: pr.number,
      isFork: headFullName !== null && headFullName !== baseFullName,
      state: pr.state,
      merged: pr.merged ?? false,
      headRef: pr.head.repo === null ? null : pr.head.ref,
    };
  }

  async getIssueLabels(
    repo: RepoRef,
    issueNumber: number,
  ): Promise<IssueLabelsInfo> {
    const response = await this.installationRequest<GitHubIssueLabelsResponse>(
      repo,
      "GET",
      `/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
    );
    const labels = response.labels.map((label) =>
      typeof label === "string" ? label : label.name,
    );

    return { labels };
  }

  async getInstallationAccessToken(repo: RepoRef): Promise<string> {
    return this.getInstallationToken(repo);
  }

  async getAppBotInfo(): Promise<AppBotInfo> {
    const jwt = this.createAppJwt();
    const app = await this.appRequest<GitHubAppResponse>("GET", "/app", jwt);
    const login = `${app.slug}[bot]`;

    // GitHub does not accept JWT auth on /users/{login}; the public endpoint
    // works without auth. We fetch with no Authorization header so the
    // installation does not need to be on a repo to look up its own bot id.
    const user = await this.publicRequest<GitHubUserResponse>(
      `/users/${encodeURIComponent(login)}`,
    );

    return { id: user.id, login: user.login, slug: app.slug };
  }

  private async publicRequest<T>(pathname: string): Promise<T> {
    const response = await fetch(`${this.apiBaseUrl}${pathname}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "oh-my-github-runner",
      },
    });

    if (!response.ok) {
      throw new Error(
        `GitHub public request failed: GET ${pathname} -> ${response.status}`,
      );
    }

    return (await response.json()) as T;
  }

  async getDefaultBranch(repo: RepoRef): Promise<string> {
    const response = await this.installationRequest<GitHubRepositoryResponse>(
      repo,
      "GET",
      `/repos/${repo.owner}/${repo.name}`,
    );

    return response.default_branch;
  }

  async postIssueComment(
    repo: RepoRef,
    issueNumber: number,
    body: string,
  ): Promise<IssueCommentRef> {
    const response = await this.installationRequest<{
      id: number;
      body: string | null;
    }>(
      repo,
      "POST",
      `/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments`,
      { body },
    );

    return { commentId: response.id, body: response.body ?? "" };
  }

  async postPullRequestComment(
    repo: RepoRef,
    pullRequestNumber: number,
    body: string,
  ): Promise<IssueCommentRef> {
    return this.postIssueComment(repo, pullRequestNumber, body);
  }

  async updateIssueComment(
    repo: RepoRef,
    commentId: number,
    body: string,
  ): Promise<void> {
    await this.installationRequest(
      repo,
      "PATCH",
      `/repos/${repo.owner}/${repo.name}/issues/comments/${commentId}`,
      { body },
    );
  }

  async deleteIssueComment(repo: RepoRef, commentId: number): Promise<void> {
    try {
      await this.installationRequest(
        repo,
        "DELETE",
        `/repos/${repo.owner}/${repo.name}/issues/comments/${commentId}`,
      );
    } catch (error) {
      // 404 = already deleted by a user or a previous cleanup; idempotent.
      if (isNotFoundError(error)) {
        return;
      }
      throw error;
    }
  }

  async addReaction(
    repo: RepoRef,
    target: ReactionTarget,
    content: ReactionContent,
  ): Promise<{ reactionId: number }> {
    const pathname =
      target.kind === "issue"
        ? `/repos/${repo.owner}/${repo.name}/issues/${target.issueNumber}/reactions`
        : `/repos/${repo.owner}/${repo.name}/issues/comments/${target.commentId}/reactions`;

    const response = await this.installationRequest<{ id: number }>(
      repo,
      "POST",
      pathname,
      { content },
    );

    return { reactionId: response.id };
  }

  async deleteReaction(
    repo: RepoRef,
    target: ReactionTarget,
    reactionId: number,
  ): Promise<void> {
    const pathname =
      target.kind === "issue"
        ? `/repos/${repo.owner}/${repo.name}/issues/${target.issueNumber}/reactions/${reactionId}`
        : `/repos/${repo.owner}/${repo.name}/issues/comments/${target.commentId}/reactions/${reactionId}`;

    try {
      await this.installationRequest(repo, "DELETE", pathname);
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      throw error;
    }
  }

  async findCommentByMarker(
    repo: RepoRef,
    issueNumber: number,
    marker: string,
  ): Promise<IssueCommentRef | null> {
    const comments = await this.installationRequest<
      Array<{ id: number; body: string | null }>
    >(
      repo,
      "GET",
      `/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments?per_page=100`,
    );

    for (const comment of comments) {
      const body = comment.body ?? "";

      if (body.includes(marker)) {
        return { commentId: comment.id, body };
      }
    }

    return null;
  }

  async findOpenPullRequestByBranch(
    repo: RepoRef,
    branchName: string,
  ): Promise<GitHubPullRequestSummary | null> {
    const pulls = await this.installationRequest<GitHubPullRequestResponse[]>(
      repo,
      "GET",
      `/repos/${repo.owner}/${repo.name}/pulls?state=open&head=${repo.owner}:${branchName}`,
    );

    const pullRequest = pulls[0];

    if (pullRequest === undefined) {
      return null;
    }

    return {
      number: pullRequest.number,
      url: pullRequest.html_url,
      branchName,
    };
  }

  async createPullRequest(
    input: CreatePullRequestInput,
  ): Promise<GitHubPullRequestSummary> {
    const pullRequest = await this.installationRequest<GitHubPullRequestResponse>(
      input.repo,
      "POST",
      `/repos/${input.repo.owner}/${input.repo.name}/pulls`,
      {
        title: input.title,
        body: input.body,
        head: input.branchName,
        base: input.baseBranch,
      },
    );

    return {
      number: pullRequest.number,
      url: pullRequest.html_url,
      branchName: input.branchName,
    };
  }

  async updatePullRequest(
    pullRequestNumber: number,
    input: CreatePullRequestInput,
  ): Promise<GitHubPullRequestSummary> {
    const pullRequest = await this.installationRequest<GitHubPullRequestResponse>(
      input.repo,
      "PATCH",
      `/repos/${input.repo.owner}/${input.repo.name}/pulls/${pullRequestNumber}`,
      {
        title: input.title,
        body: input.body,
        base: input.baseBranch,
      },
    );

    return {
      number: pullRequest.number,
      url: pullRequest.html_url,
      branchName: input.branchName,
    };
  }

  private async fetchLinkedRefs(
    repo: RepoRef,
    source: SourceRef,
    rawBody: string,
  ): Promise<LinkedRefs> {
    const mentionNumbers = parseBodyMentions(rawBody, source.number);
    const ownerRepo = `${repo.owner}/${repo.name}`;

    try {
      const response = await this.installationGraphQL<LinkedRefsGraphQLResponse>(
        repo,
        buildLinkedRefsQuery(source.kind, mentionNumbers),
        {
          owner: repo.owner,
          name: repo.name,
          number: source.number,
        },
      );

      return mapLinkedRefsResponse(response, source.kind, mentionNumbers, ownerRepo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `linked refs fetch failed for ${source.kind}#${source.number}: ${message}`,
      );
      return { closes: [], bodyMentions: [] };
    }
  }

  private async installationGraphQL<T>(
    repo: RepoRef,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const token = await this.getInstallationToken(repo);
    const response = await fetch(`${this.apiBaseUrl}/graphql`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "oh-my-github-runner",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new Error(`GitHub graphql request failed: ${response.status}`);
    }

    const payload = (await response.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };

    if (payload.errors !== undefined && payload.errors.length > 0) {
      const reason = payload.errors.map((e) => e.message).join("; ");
      throw new Error(`GitHub graphql errors: ${reason}`);
    }

    if (payload.data === undefined) {
      throw new Error("GitHub graphql response missing data");
    }

    return payload.data;
  }

  private async installationRequest<T>(
    repo: RepoRef,
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.getInstallationToken(repo);
    const response = await fetch(`${this.apiBaseUrl}${pathname}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "oh-my-github-runner",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      throw new Error(`GitHub request failed: ${method} ${pathname} -> ${response.status}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private async installationTextRequest(
    repo: RepoRef,
    method: string,
    pathname: string,
    accept: string,
  ): Promise<string> {
    const token = await this.getInstallationToken(repo);
    const response = await fetch(`${this.apiBaseUrl}${pathname}`, {
      method,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${token}`,
        "User-Agent": "oh-my-github-runner",
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub request failed: ${method} ${pathname} -> ${response.status}`);
    }

    return response.text();
  }

  private async getInstallationToken(repo: RepoRef): Promise<string> {
    const repoKey = `${repo.owner}/${repo.name}`;
    let installationId = this.installationTokenCache.getInstallationId(repoKey);

    if (installationId === undefined) {
      const installation = await this.appRequest<GitHubInstallationResponse>(
        "GET",
        `/repos/${repo.owner}/${repo.name}/installation`,
        this.createAppJwt(),
      );
      installationId = String(installation.id);
      this.installationTokenCache.setInstallationId(repoKey, installationId);
    }

    const cached = this.installationTokenCache.getToken(installationId);

    if (cached !== undefined) {
      return cached;
    }

    const tokenResponse =
      await this.appRequest<GitHubInstallationTokenResponse>(
        "POST",
        `/app/installations/${installationId}/access_tokens`,
        this.createAppJwt(),
      );

    const expiresAt = Date.parse(tokenResponse.expires_at);
    this.installationTokenCache.setToken(
      installationId,
      tokenResponse.token,
      Number.isNaN(expiresAt) ? Date.now() + 60_000 : expiresAt,
    );

    return tokenResponse.token;
  }

  private async appRequest<T>(
    method: string,
    pathname: string,
    jwt: string,
  ): Promise<T> {
    const response = await fetch(`${this.apiBaseUrl}${pathname}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "User-Agent": "oh-my-github-runner",
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub app request failed: ${method} ${pathname} -> ${response.status}`);
    }

    return (await response.json()) as T;
  }

  private createAppJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = this.base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = this.base64UrlEncode(
      JSON.stringify({
        iat: now - 60,
        exp: now + 9 * 60,
        iss: this.options.appId,
      }),
    );
    const unsigned = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");

    signer.update(unsigned);
    signer.end();

    const signature = signer.sign(this.privateKey);
    return `${unsigned}.${this.base64UrlEncode(signature)}`;
  }

  private base64UrlEncode(value: string | Buffer): string {
    return Buffer.from(value)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  private mapComment(comment: GitHubCommentResponse): GitHubComment {
    return {
      author: comment.user.login,
      body: comment.body ?? "",
    };
  }
}

interface LinkedRefsGraphQLNode {
  __typename: "Issue" | "PullRequest";
  number: number;
  title: string;
  state: string;
  merged?: boolean;
  repository: { nameWithOwner: string };
}

interface LinkedRefsGraphQLResponse {
  repository: ({
    issue?: {
      closedByPullRequestsReferences: { nodes: LinkedRefsGraphQLNode[] };
    } | null;
    pullRequest?: {
      closingIssuesReferences: { nodes: LinkedRefsGraphQLNode[] };
    } | null;
  } & Record<string, LinkedRefsGraphQLNode | null | unknown>) | null;
}

const CLOSES_FIELDS = `
  __typename
  number
  title
  state
  repository { nameWithOwner }
`;

const ALIAS_FRAGMENTS = `
  __typename
  ... on Issue {
    number
    title
    state
    repository { nameWithOwner }
  }
  ... on PullRequest {
    number
    title
    state
    merged
    repository { nameWithOwner }
  }
`;

function buildLinkedRefsQuery(
  sourceKind: "issue" | "pull_request",
  mentionNumbers: number[],
): string {
  const closesBlock =
    sourceKind === "issue"
      ? `issue(number: $number) {
           closedByPullRequestsReferences(first: 50, includeClosedPrs: true) {
             nodes {
               ${CLOSES_FIELDS}
               merged
             }
           }
         }`
      : `pullRequest(number: $number) {
           closingIssuesReferences(first: 50) {
             nodes { ${CLOSES_FIELDS} }
           }
         }`;

  const aliasBlock = mentionNumbers
    .map(
      (number, index) =>
        `m${index}: issueOrPullRequest(number: ${number}) { ${ALIAS_FRAGMENTS} }`,
    )
    .join("\n");

  return `
    query LinkedRefs($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        ${closesBlock}
        ${aliasBlock}
      }
    }
  `;
}

function mapLinkedRefsResponse(
  response: LinkedRefsGraphQLResponse,
  sourceKind: "issue" | "pull_request",
  mentionNumbers: number[],
  ownerRepo: string,
): LinkedRefs {
  const repository = response.repository;

  if (repository === null || repository === undefined) {
    return { closes: [], bodyMentions: [] };
  }

  const closesNodes =
    sourceKind === "issue"
      ? (repository.issue?.closedByPullRequestsReferences.nodes ?? [])
      : (repository.pullRequest?.closingIssuesReferences.nodes ?? []);

  const closes: LinkedRefEntry[] = [];
  for (const node of closesNodes) {
    if (node.repository.nameWithOwner !== ownerRepo) {
      continue;
    }
    closes.push(toLinkedRefEntry(node));
  }

  const closesNumbers = new Set(closes.map((entry) => entry.number));
  const bodyMentions: LinkedRefEntry[] = [];
  for (let index = 0; index < mentionNumbers.length; index += 1) {
    const number = mentionNumbers[index];
    if (number === undefined || closesNumbers.has(number)) {
      continue;
    }
    const aliasValue = (repository as Record<string, unknown>)[`m${index}`];
    if (aliasValue === null || aliasValue === undefined) {
      continue;
    }
    const node = aliasValue as LinkedRefsGraphQLNode;
    if (node.repository.nameWithOwner !== ownerRepo) {
      continue;
    }
    bodyMentions.push(toLinkedRefEntry(node));
  }

  return { closes, bodyMentions };
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && / -> 404$/.test(error.message);
}

function toLinkedRefEntry(node: LinkedRefsGraphQLNode): LinkedRefEntry {
  const kind: LinkedRefKind =
    node.__typename === "PullRequest" ? "pull_request" : "issue";
  const merged = node.__typename === "PullRequest" && node.merged === true;
  const state: LinkedRefState =
    node.__typename === "PullRequest"
      ? merged || node.state.toUpperCase() === "MERGED" || node.state.toUpperCase() === "CLOSED"
        ? "closed"
        : "open"
      : node.state.toUpperCase() === "OPEN"
        ? "open"
        : "closed";

  return {
    kind,
    number: node.number,
    title: node.title,
    state,
    ...(kind === "pull_request" ? { merged } : {}),
  };
}
