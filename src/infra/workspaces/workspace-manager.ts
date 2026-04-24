import type { RepoRef, TaskRecord } from "../../domain/task.js";

export interface WorkspaceHandle {
  workspacePath: string;
}

export interface MutateWorkspaceHandle extends WorkspaceHandle {
  branchName: string;
}

export interface WorkspaceManager {
  prepareObserveWorkspace(
    task: TaskRecord,
    checkoutRef?: string,
  ): Promise<WorkspaceHandle>;
  prepareMutateWorkspace(
    repo: RepoRef,
    task: TaskRecord,
    baseBranch: string,
    branchName: string,
  ): Promise<MutateWorkspaceHandle>;
  hasChanges(workspace: WorkspaceHandle): Promise<boolean>;
  commitAll(workspace: MutateWorkspaceHandle, message: string): Promise<void>;
  pushBranch(workspace: MutateWorkspaceHandle): Promise<void>;
  cleanupWorkspace(workspace: WorkspaceHandle): Promise<void>;
}
