# Execution Context Refactor Design

Date: 2026-04-24
Status: Approved inline in chat for implementation

## Goal

Reduce coupling in task execution, make prompt/context handling instruction-driven, and ensure pull request observe tasks run against the correct git ref.

## Scope

This refactor is intentionally narrow. It focuses on the execution path that starts in `ExecutionService` and crosses the GitHub client and workspace manager boundaries.

Included:

- split prompt construction out of `ExecutionService`
- split GitHub write-back behavior out of `ExecutionService`
- make source context loading respect instruction context flags for body, comments, and diff
- let observe workspaces for pull request sources check out the pull request head ref
- keep current end-to-end behavior for issue observe and mutate flows

Not included:

- queue storage redesign
- git credential/token wiring for clone and push
- linked pull request discovery for `include_linked_prs`

## Design

### 1. Smaller execution collaborators

`ExecutionService` remains the orchestrator, but it should stop owning string assembly and GitHub write-back details.

New collaborators:

- `ExecutionPromptBuilder`: builds the agent prompt from task, instruction, and collected source context
- `GitHubResultWriter`: performs allowed GitHub write-back operations for observe and mutate flows

This keeps orchestration, prompt formatting, and GitHub publication in separate units with narrower tests.

### 2. Instruction-driven context collection

`GitHubClient.getSourceContext()` should accept the loaded instruction context. The GitHub adapter will still fetch core source metadata needed for routing, but optional content should only be collected when requested:

- issue body only when `includeIssueBody`
- issue comments only when `includeIssueComments`
- pull request body only when `includePrBody`
- pull request comments only when `includePrComments`
- pull request diff only when `includePrDiff`

Prompt rendering should also omit sections that were not requested instead of printing empty placeholders.

### 3. Pull request observe workspace selection

Observe mode currently prepares a plain clone without a requested ref. For pull request sources, the execution path should pass the pull request `headRef` into workspace preparation so repository reads match the source under review.

The workspace interface should accept an optional checkout ref for observe flows. Git workspaces should fetch and checkout that ref when provided.

## Testing

Add unit coverage for:

- prompt/context omission when instruction context disables fields
- pull request observe execution requesting the head ref in workspace preparation
- existing observe and mutate success paths remaining green after module extraction

## Risks

- prompt output changes slightly because omitted sections will now be removed instead of rendered empty
- partial context support must preserve enough PR metadata to allow mutate flow branch selection
