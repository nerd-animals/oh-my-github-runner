import type { SourceKind } from "./task.js";

export type ExecutionMode = "observe" | "mutate";

export interface InstructionContext {
  includeIssueBody?: boolean;
  includeIssueComments?: boolean;
  includeLinkedPrs?: boolean;
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
  agent: string;
  timeoutSec: number;
}

export interface InstructionDefinition {
  id: string;
  revision: number;
  sourceKind: SourceKind;
  mode: ExecutionMode;
  context: InstructionContext;
  githubActions: string[];
  permissions: InstructionPermissions;
  execution: InstructionExecution;
}

export interface InstructionLoader {
  loadById(instructionId: string): Promise<InstructionDefinition>;
}
