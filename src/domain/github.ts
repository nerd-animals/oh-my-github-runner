import type { RepoRef } from "./task.js";

export interface GitHubComment {
  author: string;
  body: string;
}

export type LinkedRefKind = "issue" | "pull_request";
export type LinkedRefState = "open" | "closed";

export interface LinkedRefEntry {
  kind: LinkedRefKind;
  number: number;
  title: string;
  state: LinkedRefState;
  merged?: boolean;
}

export interface LinkedRefs {
  closes: LinkedRefEntry[];
  bodyMentions: LinkedRefEntry[];
}

export interface GitHubIssueContext {
  kind: "issue";
  title: string;
  body: string;
  comments: GitHubComment[];
  linkedRefs: LinkedRefs;
}

export interface GitHubPullRequestContext {
  kind: "pull_request";
  title: string;
  body: string;
  comments: GitHubComment[];
  diff: string;
  baseRef: string;
  headRef: string;
  linkedRefs: LinkedRefs;
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
