# Execution Context Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor execution flow into smaller modules while making context loading and pull request observe work instruction-aware.

**Architecture:** Keep `ExecutionService` as the orchestrator, but move prompt formatting and GitHub publication into focused collaborators. Extend the GitHub and workspace boundaries just enough to make instruction context and pull request refs explicit.

**Tech Stack:** TypeScript, node:test, local filesystem persistence, GitHub App HTTP client

---

## Planned File Structure

- Add: `src/services/execution/execution-prompt-builder.ts`
- Add: `src/services/execution/github-result-writer.ts`
- Modify: `src/services/execution-service.ts`
- Modify: `src/infra/github/github-client.ts`
- Modify: `src/infra/github/github-app-client.ts`
- Modify: `src/infra/workspaces/workspace-manager.ts`
- Modify: `src/infra/workspaces/git-workspace-manager.ts`
- Modify: `tests/unit/execution-service.test.ts`

## Task 1: Lock In Missing Behavior With Tests

**Files:**
- Modify: `tests/unit/execution-service.test.ts`

- [ ] Add a failing test that runs pull request observe work and asserts `prepareObserveWorkspace()` receives the pull request head ref.
- [ ] Run the execution-service test file and verify the new test fails for the expected reason.
- [ ] Add a failing test that disables issue body and comments in the instruction context and asserts the generated prompt omits those sections.
- [ ] Run the execution-service test file and verify the prompt test fails for the expected reason.

## Task 2: Extract Prompt And GitHub Result Modules

**Files:**
- Add: `src/services/execution/execution-prompt-builder.ts`
- Add: `src/services/execution/github-result-writer.ts`
- Modify: `src/services/execution-service.ts`

- [ ] Implement `ExecutionPromptBuilder` as a pure formatter over task, instruction, and source context.
- [ ] Implement `GitHubResultWriter` as a focused adapter over allowed issue comment, pull request comment, and pull request create/update behavior.
- [ ] Update `ExecutionService` to delegate prompt construction and write-back to the new modules while keeping orchestration behavior unchanged.
- [ ] Run the execution-service test file and verify extracted-module behavior is green.

## Task 3: Make Context Collection And Observe Workspaces Explicit

**Files:**
- Modify: `src/infra/github/github-client.ts`
- Modify: `src/infra/github/github-app-client.ts`
- Modify: `src/infra/workspaces/workspace-manager.ts`
- Modify: `src/infra/workspaces/git-workspace-manager.ts`
- Modify: `src/services/execution-service.ts`

- [ ] Extend `GitHubClient.getSourceContext()` to accept instruction context.
- [ ] Update `GitHubAppClient` to skip optional issue body, issue comments, pull request body, pull request comments, and diff fetches when not requested.
- [ ] Extend observe workspace preparation to accept an optional checkout ref.
- [ ] Update `ExecutionService` to pass pull request `headRef` into observe workspace preparation.
- [ ] Run the execution-service test file and verify the new behavior is green.

## Task 4: Full Verification

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/unit/execution-service.test.ts`

- [ ] Remove any small leftover duplication that became obvious during refactor if it stays within scope.
- [ ] Run `powershell -ExecutionPolicy Bypass -File .\tools\npm.ps1 run test` and verify the full suite passes.
- [ ] Run `powershell -ExecutionPolicy Bypass -File .\tools\npm.ps1 run compile` and verify runtime compilation passes.
- [ ] Summarize the remaining known gaps: linked pull request context and git credential wiring.
