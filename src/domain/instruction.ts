import type { SourceKind } from "./task.js";

export type ExecutionMode = "observe" | "mutate";

export type InstructionWorkflow = "observe" | "mutate" | "pr_implement";

export interface InstructionContext {
  includeIssueBody?: boolean;
  includeIssueComments?: boolean;
  includePrBody?: boolean;
  includePrComments?: boolean;
  includePrDiff?: boolean;
}

export interface InstructionPermissions {
  codeRead: boolean;
  codeWrite: boolean;
  gitPush: boolean;
  prCreate: boolean;
  prUpdate: boolean;
  commentWrite: boolean;
}

export interface InstructionExecution {
  timeoutSec: number;
}

export interface InstructionDefinition {
  id: string;
  revision: number;
  sourceKind: SourceKind;
  mode: ExecutionMode;
  workflow: InstructionWorkflow;
  persona: string;
  guidance?: string;
  context: InstructionContext;
  githubActions: string[];
  permissions: InstructionPermissions;
  execution: InstructionExecution;
}
