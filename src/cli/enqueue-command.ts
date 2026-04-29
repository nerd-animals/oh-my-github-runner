import path from "node:path";
import { FileQueueStore } from "../infra/queue/file-queue-store.js";
import { EnqueueService } from "../services/enqueue-service.js";

export interface EnqueueCommandInput {
  repoOwner: string;
  repoName: string;
  sourceKind: "issue" | "pull_request";
  sourceNumber: number;
  instructionId: string;
  agent: string;
}

export async function runEnqueueCommand(input: EnqueueCommandInput) {
  const workspaceRoot = process.cwd();
  const service = new EnqueueService({
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
    agent: input.agent,
    requestedBy: "cli",
  });
}
