import type { ExecutionMode } from "../../domain/instruction.js";

export function buildClaudeToolArgs(mode: ExecutionMode): string[] {
  if (mode === "observe") {
    return [
      "--allowed-tools",
      "Read Grep Glob Bash(gh:*) Bash(git log:*) Bash(git diff:*) Bash(git status:*) Bash(git show:*)",
      "--disallowed-tools",
      "Edit Write MultiEdit NotebookEdit Bash(git push:*) Bash(git commit:*) Bash(git add:*) Bash(rm:*) Bash(mv:*)",
    ];
  }

  return [
    "--allowed-tools",
    "Read Grep Glob Edit Write MultiEdit Bash(gh:*) Bash(git:*) Bash(npm:*) Bash(node:*)",
    "--disallowed-tools",
    "Bash(git push:*)",
  ];
}
