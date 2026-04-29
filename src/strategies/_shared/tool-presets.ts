export const OBSERVE_ALLOWED: readonly string[] = [
  "Read",
  "Grep",
  "Glob",
  "Bash(gh:*)",
  "Bash(git log:*)",
  "Bash(git diff:*)",
  "Bash(git status:*)",
  "Bash(git show:*)",
];

export const OBSERVE_DISALLOWED: readonly string[] = [
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Bash(git push:*)",
  "Bash(git commit:*)",
  "Bash(git add:*)",
  "Bash(rm:*)",
  "Bash(mv:*)",
];

export const COLLECT_ONLY_ALLOWED: readonly string[] = [
  "Read",
  "Grep",
  "Glob",
  "Bash(gh issue view:*)",
  "Bash(gh pr view:*)",
  "Bash(gh api:*)",
  "Bash(git log:*)",
  "Bash(git diff:*)",
  "Bash(git status:*)",
  "Bash(git show:*)",
];

export const COLLECT_ONLY_DISALLOWED: readonly string[] = [
  ...OBSERVE_DISALLOWED,
  "Bash(gh issue comment:*)",
  "Bash(gh pr comment:*)",
  "Bash(gh issue create:*)",
  "Bash(gh pr create:*)",
  "Bash(gh issue edit:*)",
  "Bash(gh pr edit:*)",
];

export const MUTATE_ALLOWED: readonly string[] = [
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "MultiEdit",
  "Bash(gh:*)",
  "Bash(git:*)",
  "Bash(npm:*)",
  "Bash(node:*)",
];

export const MUTATE_DISALLOWED: readonly string[] = [
  "Bash(gh pr merge:*)",
];
