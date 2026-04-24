import type {
  CreatePullRequestInput,
  GitHubPullRequestSummary,
  GitHubSourceContext,
} from "../../domain/github.js";
import type { InstructionContext } from "../../domain/instruction.js";
import type { RepoRef, SourceRef } from "../../domain/task.js";

export interface GitHubClient {
  getSourceContext(
    repo: RepoRef,
    source: SourceRef,
    instructionContext: InstructionContext,
  ): Promise<GitHubSourceContext>;
  getDefaultBranch(repo: RepoRef): Promise<string>;
  postIssueComment(repo: RepoRef, issueNumber: number, body: string): Promise<void>;
  postPullRequestComment(
    repo: RepoRef,
    pullRequestNumber: number,
    body: string,
  ): Promise<void>;
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
