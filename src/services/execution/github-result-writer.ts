import type {
  CreatePullRequestInput,
  GitHubPullRequestSummary,
} from "../../domain/github.js";
import type { InstructionDefinition } from "../../domain/instruction.js";
import type { TaskRecord } from "../../domain/task.js";
import type { GitHubClient } from "../../infra/github/github-client.js";

export interface GitHubResultWriterDependencies {
  githubClient: GitHubClient;
}

export interface WriteObserveResultInput {
  task: TaskRecord;
  instruction: InstructionDefinition;
  body: string;
}

export interface WriteMutateResultInput {
  task: TaskRecord;
  instruction: InstructionDefinition;
  baseBranch: string;
  branchName: string;
  title: string;
  body: string;
}

export class GitHubResultWriter {
  constructor(private readonly dependencies: GitHubResultWriterDependencies) {}

  async writeObserveResult(input: WriteObserveResultInput): Promise<void> {
    if (
      input.task.source.kind === "issue" &&
      input.instruction.githubActions.includes("issue_comment")
    ) {
      await this.dependencies.githubClient.postIssueComment(
        input.task.repo,
        input.task.source.number,
        input.body,
      );
    }

    if (
      input.task.source.kind === "pull_request" &&
      input.instruction.githubActions.includes("pull_request_comment")
    ) {
      await this.dependencies.githubClient.postPullRequestComment(
        input.task.repo,
        input.task.source.number,
        input.body,
      );
    }
  }

  async writeMutateResult(
    input: WriteMutateResultInput,
  ): Promise<GitHubPullRequestSummary> {
    const createPullRequestInput: CreatePullRequestInput = {
      repo: input.task.repo,
      branchName: input.branchName,
      baseBranch: input.baseBranch,
      title: input.title,
      body: input.body,
    };
    const existingPullRequest =
      await this.dependencies.githubClient.findOpenPullRequestByBranch(
        input.task.repo,
        input.branchName,
      );
    const pullRequest = existingPullRequest
      ? await this.dependencies.githubClient.updatePullRequest(
          existingPullRequest.number,
          createPullRequestInput,
        )
      : await this.dependencies.githubClient.createPullRequest(
          createPullRequestInput,
        );

    if (
      input.task.source.kind === "issue" &&
      input.instruction.githubActions.includes("issue_comment")
    ) {
      await this.dependencies.githubClient.postIssueComment(
        input.task.repo,
        input.task.source.number,
        `Created or updated PR: ${pullRequest.url}`,
      );
    }

    return pullRequest;
  }
}
