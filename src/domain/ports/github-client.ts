import type {
  CreatePullRequestInput,
  GitHubPullRequestSummary,
  GitHubSourceContext,
} from "../github.js";
import type { InstructionContext } from "../instruction.js";
import type { RepoRef, SourceRef } from "../task.js";

export interface PullRequestStateInfo {
  number: number;
  isFork: boolean;
  state: "open" | "closed";
  merged: boolean;
  headRef: string | null;
}

export interface AppBotInfo {
  id: number;
  login: string;
  slug: string;
}

export interface IssueLabelsInfo {
  labels: string[];
}

export type ReactionContent =
  | "+1"
  | "-1"
  | "laugh"
  | "confused"
  | "heart"
  | "hooray"
  | "rocket"
  | "eyes";

export type ReactionTarget =
  | { kind: "issue"; issueNumber: number }
  | { kind: "comment"; commentId: number };

export interface IssueCommentRef {
  commentId: number;
  body: string;
}

export interface GitHubClient {
  getSourceContext(
    repo: RepoRef,
    source: SourceRef,
    instructionContext: InstructionContext,
  ): Promise<GitHubSourceContext>;
  getDefaultBranch(repo: RepoRef): Promise<string>;
  getPullRequestState(
    repo: RepoRef,
    pullRequestNumber: number,
  ): Promise<PullRequestStateInfo>;
  getIssueLabels(
    repo: RepoRef,
    issueNumber: number,
  ): Promise<IssueLabelsInfo>;
  getAppBotInfo(): Promise<AppBotInfo>;
  getInstallationAccessToken(repo: RepoRef): Promise<string>;
  postIssueComment(
    repo: RepoRef,
    issueNumber: number,
    body: string,
  ): Promise<IssueCommentRef>;
  postPullRequestComment(
    repo: RepoRef,
    pullRequestNumber: number,
    body: string,
  ): Promise<IssueCommentRef>;
  updateIssueComment(
    repo: RepoRef,
    commentId: number,
    body: string,
  ): Promise<void>;
  addReaction(
    repo: RepoRef,
    target: ReactionTarget,
    content: ReactionContent,
  ): Promise<void>;
  findCommentByMarker(
    repo: RepoRef,
    issueNumber: number,
    marker: string,
  ): Promise<IssueCommentRef | null>;
  findOpenPullRequestByBranch(
    repo: RepoRef,
    branchName: string,
  ): Promise<GitHubPullRequestSummary | null>;
  createPullRequest(
    input: CreatePullRequestInput,
  ): Promise<GitHubPullRequestSummary>;
  updatePullRequest(
    pullRequestNumber: number,
    input: CreatePullRequestInput,
  ): Promise<GitHubPullRequestSummary>;
}
