import path from "node:path";
import { FileInstructionLoader } from "../infra/instructions/instruction-loader.js";
import { FileQueueStore } from "../infra/queue/file-queue-store.js";
import { EnqueueService } from "../services/enqueue-service.js";

export interface EnqueueCommandInput {
  repoOwner: string;
  repoName: string;
  sourceKind: "issue" | "pull_request";
  sourceNumber: number;
  instructionId: string;
}

export async function runEnqueueCommand(input: EnqueueCommandInput) {
  const workspaceRoot = process.cwd();
  const service = new EnqueueService({
    instructionLoader: new FileInstructionLoader(
      path.join(workspaceRoot, "definitions", "instructions"),
    ),
    queueStore: new FileQueueStore({
      dataDir: path.join(workspaceRoot, "var", "queue"),
    }),
  });

  return service.enqueue({
    repo: {
      owner: input.repoOwner,
      name: input.repoName,
    },
    source: {
      kind: input.sourceKind,
      number: input.sourceNumber,
    },
    instructionId: input.instructionId,
    requestedBy: "cli",
  });
}
