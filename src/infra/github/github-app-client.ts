import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import type {
  CreatePullRequestInput,
  GitHubComment,
  GitHubPullRequestSummary,
  GitHubSourceContext,
} from "../../domain/github.js";
import type { InstructionContext } from "../../domain/instruction.js";
import type { RepoRef, SourceRef } from "../../domain/task.js";
import type {
  AppBotInfo,
  GitHubClient,
  IssueLabelsInfo,
  PullRequestStateInfo,
} from "./github-client.js";
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

      return {
        kind: "issue",
        title: issue.title,
        body:
          instructionContext.includeIssueBody === true ? (issue.body ?? "") : "",
        comments: comments.map(this.mapComment),
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
    const user = await this.appRequest<GitHubUserResponse>(
      "GET",
      `/users/${encodeURIComponent(login)}`,
      jwt,
    );

    return { id: user.id, login: user.login, slug: app.slug };
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
  ): Promise<void> {
    await this.installationRequest(
      repo,
      "POST",
      `/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments`,
      { body },
    );
  }

  async postPullRequestComment(
    repo: RepoRef,
    pullRequestNumber: number,
    body: string,
  ): Promise<void> {
    await this.postIssueComment(repo, pullRequestNumber, body);
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
