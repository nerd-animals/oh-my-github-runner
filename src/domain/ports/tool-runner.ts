import type { ToolRunInput, ToolRunResult } from "../tool.js";

export interface ToolRunner {
  run(input: ToolRunInput): Promise<ToolRunResult>;
  // Remove tool-specific artifacts left in or around `workspacePath`
  // (e.g. session files under ~/.<tool>/projects/<encoded-workspace>).
  // Called after the workspace is disposed; idempotent and safe to call
  // when nothing was left behind.
  cleanupArtifacts(workspacePath: string): Promise<void>;
}
