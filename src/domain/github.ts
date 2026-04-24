import type { RepoRef } from "./task.js";

export interface GitHubComment {
  author: string;
  body: string;
}

export interface GitHubIssueContext {
  kind: "issue";
  title: string;
  body: string;
  comments: GitHubComment[];
}

export interface GitHubPullRequestContext {
  kind: "pull_request";
  title: string;
  body: string;
  comments: GitHubComment[];
  diff: string;
  baseRef: string;
  headRef: string;
}

export type GitHubSourceContext = GitHubIssueContext | GitHubPullRequestContext;

export interface GitHubPullRequestSummary {
  number: number;
  url: string;
  branchName: string;
}

export interface CreatePullRequestInput {
  repo: RepoRef;
  branchName: string;
  baseBranch: string;
  title: string;
  body: string;
}
