import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { RepoRef, TaskRecord } from "../../domain/task.js";
import type { ProcessRunner } from "../platform/process-runner.js";
import type {
  MutateWorkspaceHandle,
  WorkspaceHandle,
  WorkspaceManager,
} from "./workspace-manager.js";

export interface GitWorkspaceManagerOptions {
  reposDir: string;
  workspacesDir: string;
  processRunner: ProcessRunner;
  gitExecutable?: string;
  githubWebBaseUrl?: string;
}

export class GitWorkspaceManager implements WorkspaceManager {
  private readonly gitExecutable: string;
  private readonly githubWebBaseUrl: string;

  constructor(private readonly options: GitWorkspaceManagerOptions) {
    this.gitExecutable = options.gitExecutable ?? "git";
    this.githubWebBaseUrl = options.githubWebBaseUrl ?? "https://github.com";
  }

  async prepareObserveWorkspace(
    task: TaskRecord,
    checkoutRef?: string,
  ): Promise<WorkspaceHandle> {
    const repoUrl = this.getRepoUrl(task.repo);
    const mirrorPath = this.getMirrorPath(task.repo);
    const workspacePath = this.getWorkspacePath(task.taskId);

    await this.ensureMirror(repoUrl, mirrorPath);
    await this.cloneWorkspace(mirrorPath, workspacePath, repoUrl);
    await this.checkoutObserveRef(workspacePath, checkoutRef);

    return { workspacePath };
  }

  async prepareMutateWorkspace(
    repo: RepoRef,
    task: TaskRecord,
    baseBranch: string,
    branchName: string,
  ): Promise<MutateWorkspaceHandle> {
    const repoUrl = this.getRepoUrl(repo);
    const mirrorPath = this.getMirrorPath(repo);
    const workspacePath = this.getWorkspacePath(task.taskId);

    await this.ensureMirror(repoUrl, mirrorPath);
    await this.cloneWorkspace(mirrorPath, workspacePath, repoUrl);
    await this.runGit(["-C", workspacePath, "fetch", "origin", "--prune"]);
    await this.runGit([
      "-C",
      workspacePath,
      "checkout",
      "-B",
      branchName,
      `origin/${baseBranch}`,
    ]);

    return {
      workspacePath,
      branchName,
    };
  }

  async hasChanges(workspace: WorkspaceHandle): Promise<boolean> {
    const result = await this.runGit([
      "-C",
      workspace.workspacePath,
      "status",
      "--porcelain",
    ]);

    return result.stdout.trim().length > 0;
  }

  async commitAll(
    workspace: MutateWorkspaceHandle,
    message: string,
  ): Promise<void> {
    await this.runGit(["-C", workspace.workspacePath, "add", "-A"]);
    await this.runGit([
      "-C",
      workspace.workspacePath,
      "-c",
      "user.name=AI Runner",
      "-c",
      "user.email=ai-runner@local",
      "commit",
      "-m",
      message,
    ]);
  }

  async pushBranch(workspace: MutateWorkspaceHandle): Promise<void> {
    await this.runGit([
      "-C",
      workspace.workspacePath,
      "push",
      "-u",
      "origin",
      workspace.branchName,
    ]);
  }

  async cleanupWorkspace(workspace: WorkspaceHandle): Promise<void> {
    await rm(workspace.workspacePath, { recursive: true, force: true });
  }

  private async ensureMirror(repoUrl: string, mirrorPath: string): Promise<void> {
    await mkdir(path.dirname(mirrorPath), { recursive: true });

    if (await this.pathExists(mirrorPath)) {
      await this.runGit(["-C", mirrorPath, "fetch", "origin", "--prune"]);
      return;
    }

    await this.runGit(["clone", "--mirror", repoUrl, mirrorPath]);
  }

  private async cloneWorkspace(
    mirrorPath: string,
    workspacePath: string,
    repoUrl: string,
  ): Promise<void> {
    await rm(workspacePath, { recursive: true, force: true });
    await mkdir(path.dirname(workspacePath), { recursive: true });
    await this.runGit(["clone", mirrorPath, workspacePath]);
    await this.runGit(["-C", workspacePath, "remote", "set-url", "origin", repoUrl]);
  }

  private async checkoutObserveRef(
    workspacePath: string,
    checkoutRef: string | undefined,
  ): Promise<void> {
    if (checkoutRef === undefined || checkoutRef.length === 0) {
      return;
    }

    await this.runGit(["-C", workspacePath, "fetch", "origin", "--prune"]);
    await this.runGit([
      "-C",
      workspacePath,
      "checkout",
      "--detach",
      `origin/${checkoutRef}`,
    ]);
  }

  private async runGit(args: string[]) {
    const result = await this.options.processRunner.run({
      command: this.gitExecutable,
      args,
    });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || `git failed: ${args.join(" ")}`);
    }

    return result;
  }

  private getMirrorPath(repo: RepoRef): string {
    return path.join(this.options.reposDir, repo.owner, repo.name, "mirror.git");
  }

  private getWorkspacePath(taskId: string): string {
    return path.join(this.options.workspacesDir, taskId);
  }

  private getRepoUrl(repo: RepoRef): string {
    return `${this.githubWebBaseUrl}/${repo.owner}/${repo.name}.git`;
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
