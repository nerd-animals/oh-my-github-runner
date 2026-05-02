// Permission vocabulary used by strategies. ToolRunner implementations
// translate these strings into each tool's native permission syntax.
//
// Grammar:
//   read, grep, glob, edit, write   built-in capabilities
//   shell:<token-prefix>            shell command prefix (whitespace-tokenized)
//
// Allow-list is default-deny; everything not listed is implicitly forbidden.
// Use `disallowed*` only when you need a narrow carve-out from a broad allow
// (e.g. allow `shell:gh` in general but block `shell:gh pr merge`).
export const OBSERVE_ALLOWED: readonly string[] = [
  "read",
  "grep",
  "glob",
  "shell:gh",
  "shell:git log",
  "shell:git diff",
  "shell:git status",
  "shell:git show",
];

export const COLLECT_ONLY_ALLOWED: readonly string[] = [
  "read",
  "grep",
  "glob",
  "shell:gh issue view",
  "shell:gh pr view",
  "shell:gh api",
  "shell:git log",
  "shell:git diff",
  "shell:git status",
  "shell:git show",
];

export const MUTATE_ALLOWED: readonly string[] = [
  "read",
  "grep",
  "glob",
  "edit",
  "write",
  "shell:gh",
  "shell:git",
  "shell:npm",
  "shell:node",
];

export const MUTATE_DISALLOWED: readonly string[] = [
  "shell:gh pr merge",
];

// Narrow carve-outs from `OBSERVE_ALLOWED` for issue-comment-reply: the
// strategy's contract lets the model use the full `gh` surface to fulfill
// natural-language action delegations (label, open follow-up issue, etc.),
// but anything that can mutate the codebase or repo metadata stays blocked.
export const REPLY_DISALLOWED: readonly string[] = [
  "shell:gh pr merge",
  "shell:gh repo edit",
  "shell:gh repo delete",
  "shell:gh release create",
  "shell:gh release delete",
  "shell:gh ruleset",
  "shell:gh workflow",
  "shell:git push",
];
