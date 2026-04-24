# Complete V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the first usable end-to-end version of the local GitHub runner assistant, including queue state transitions, scheduling, daemon execution, local logs, headless agent orchestration, and GitHub/workspace adapters.

**Architecture:** Keep the system single-VM and dependency-light. Core correctness lives in pure orchestration services with unit tests, while runtime adapters handle git, GitHub API access, workspaces, and the headless agent command. The daemon owns concurrency, same-source supersede behavior, same-repo mutate serialization, and local TTL log cleanup.

**Tech Stack:** Node.js, TypeScript, built-in fetch, built-in crypto, node:test, local filesystem persistence

---

## Planned File Structure

- Modify: `src/domain/task.ts`
- Modify: `src/domain/task-status.ts`
- Add: `src/domain/github.ts`
- Add: `src/domain/agent.ts`
- Modify: `src/infra/queue/queue-store.ts`
- Modify: `src/infra/queue/file-queue-store.ts`
- Modify: `src/infra/logs/log-store.ts`
- Add: `src/infra/logs/file-log-store.ts`
- Modify: `src/infra/github/github-client.ts`
- Add: `src/infra/github/github-app-client.ts`
- Modify: `src/infra/workspaces/workspace-manager.ts`
- Add: `src/infra/workspaces/git-workspace-manager.ts`
- Add: `src/infra/platform/process-runner.ts`
- Add: `src/infra/agent/agent-runner.ts`
- Add: `src/infra/agent/headless-command-agent-runner.ts`
- Modify: `src/services/scheduler-service.ts`
- Modify: `src/services/execution-service.ts`
- Modify: `src/daemon/runner-daemon.ts`
- Modify: `src/index.ts`
- Add: `tests/unit/scheduler-service.test.ts`
- Add: `tests/unit/file-log-store.test.ts`
- Add: `tests/unit/execution-service.test.ts`

## Immediate Execution Scope

Execute the remaining v1 implementation inline in this session.
