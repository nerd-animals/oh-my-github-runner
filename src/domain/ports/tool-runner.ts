import type { ToolRunInput, ToolRunResult } from "../tool.js";

export interface ToolRunner {
  run(input: ToolRunInput): Promise<ToolRunResult>;
}
