import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import type {
  InstructionContext,
  InstructionDefinition,
  InstructionLoader,
  InstructionPermissions,
} from "../../domain/instruction.js";

interface RawInstructionDefinition {
  id: string;
  revision: number;
  source_kind: InstructionDefinition["sourceKind"];
  mode: InstructionDefinition["mode"];
  context?: Record<string, boolean>;
  permissions: {
    code_read: boolean;
    code_write: boolean;
    git_push: boolean;
    pr_create: boolean;
    pr_update: boolean;
    comment_write: boolean;
  };
  github_actions: string[];
  execution: {
    agent: string;
    timeout_sec: number;
  };
}

export interface LoadInstructionDefinitionInput {
  definitionsDir: string;
  instructionId: string;
}

function mapContext(context: Record<string, boolean> | undefined): InstructionContext {
  return {
    ...(context?.include_issue_body !== undefined
      ? { includeIssueBody: context.include_issue_body }
      : {}),
    ...(context?.include_issue_comments !== undefined
      ? { includeIssueComments: context.include_issue_comments }
      : {}),
    ...(context?.include_linked_prs !== undefined
      ? { includeLinkedPrs: context.include_linked_prs }
      : {}),
    ...(context?.include_pr_body !== undefined
      ? { includePrBody: context.include_pr_body }
      : {}),
    ...(context?.include_pr_comments !== undefined
      ? { includePrComments: context.include_pr_comments }
      : {}),
    ...(context?.include_pr_diff !== undefined
      ? { includePrDiff: context.include_pr_diff }
      : {}),
  };
}

function mapPermissions(
  permissions: RawInstructionDefinition["permissions"],
): InstructionPermissions {
  return {
    codeRead: permissions.code_read,
    codeWrite: permissions.code_write,
    gitPush: permissions.git_push,
    prCreate: permissions.pr_create,
    prUpdate: permissions.pr_update,
    commentWrite: permissions.comment_write,
  };
}

export async function loadInstructionDefinition({
  definitionsDir,
  instructionId,
}: LoadInstructionDefinitionInput): Promise<InstructionDefinition> {
  const filePath = path.resolve(definitionsDir, `${instructionId}.yaml`);
  const fileContents = await readFile(filePath, "utf8");
  const raw = parse(fileContents) as RawInstructionDefinition;

  return {
    id: raw.id,
    revision: raw.revision,
    sourceKind: raw.source_kind,
    mode: raw.mode,
    context: mapContext(raw.context),
    permissions: mapPermissions(raw.permissions),
    githubActions: raw.github_actions,
    execution: {
      agent: raw.execution.agent,
      timeoutSec: raw.execution.timeout_sec,
    },
  };
}

export class FileInstructionLoader implements InstructionLoader {
  constructor(private readonly definitionsDir: string) {}

  loadById(instructionId: string): Promise<InstructionDefinition> {
    return loadInstructionDefinition({
      definitionsDir: this.definitionsDir,
      instructionId,
    });
  }
}
