# V1 Project Structure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the initial repository structure for the Oracle VM GitHub runner assistant, including the TypeScript workspace layout, instruction files, and git initialization baseline.

**Architecture:** The first cut uses a single Node.js + TypeScript workspace with a clear split between CLI ingress, daemon scheduling, domain models, GitHub integration, and local infrastructure adapters. This phase creates only the scaffold and stable file boundaries so later implementation can proceed in small vertical slices.

**Tech Stack:** Node.js, TypeScript, Vitest, YAML instruction files, Git

---

## Planned File Structure

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `README.md`
- Create: `definitions/instructions/issue-comment-opinion.yaml`
- Create: `definitions/instructions/issue-to-pr.yaml`
- Create: `definitions/instructions/pr-review-comment.yaml`
- Create: `src/cli/main.ts`
- Create: `src/cli/enqueue-command.ts`
- Create: `src/daemon/runner-daemon.ts`
- Create: `src/domain/task.ts`
- Create: `src/domain/instruction.ts`
- Create: `src/domain/task-status.ts`
- Create: `src/infra/queue/queue-store.ts`
- Create: `src/infra/logs/log-store.ts`
- Create: `src/infra/github/github-client.ts`
- Create: `src/infra/workspaces/workspace-manager.ts`
- Create: `src/services/enqueue-service.ts`
- Create: `src/services/scheduler-service.ts`
- Create: `src/services/execution-service.ts`
- Create: `src/index.ts`
- Create: `tests/unit/.gitkeep`

### Task 1: Create Repository Metadata And Tooling Baseline

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `README.md`

- [ ] **Step 1: Add `package.json` with the initial scripts**

```json
{
  "name": "oh-my-github-runner",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc --noEmit",
    "test": "vitest run",
    "enqueue": "tsx src/cli/main.ts enqueue",
    "daemon": "tsx src/index.ts"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.8.0",
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 2: Add `tsconfig.json` for a strict TypeScript workspace**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "rootDir": ".",
    "outDir": "dist",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Add `.gitignore` to exclude runtime clutter**

```gitignore
node_modules/
dist/
.env
.env.*
tmp/
var/
*.log
```

- [ ] **Step 4: Add a `README.md` that explains the project layout**

```md
# oh-my-github-runner

Single-VM queue consumer and executor for GitHub-native AI coding tasks.

## Layout

- `definitions/instructions`: reusable task instructions
- `src/cli`: local enqueue entrypoints
- `src/daemon`: long-running queue poller
- `src/domain`: core types and contracts
- `src/services`: orchestration logic
- `src/infra`: storage and external integrations
- `tests`: unit and integration tests
```

- [ ] **Step 5: Initialize git**

Run: `git init -b main`
Expected: repository initialized with `main` as the default branch

### Task 2: Create Instruction Registry Files

**Files:**
- Create: `definitions/instructions/issue-comment-opinion.yaml`
- Create: `definitions/instructions/issue-to-pr.yaml`
- Create: `definitions/instructions/pr-review-comment.yaml`

- [ ] **Step 1: Add the observe-only issue comment instruction**

```yaml
id: issue-comment-opinion
revision: 1
source_kind: issue
mode: observe
context:
  include_issue_body: true
  include_issue_comments: true
permissions:
  code_read: true
  code_write: false
  git_push: false
  pr_create: false
  pr_update: false
  comment_write: true
github_actions:
  - issue_comment
execution:
  agent: codex-cli
  timeout_sec: 1800
```

- [ ] **Step 2: Add the mutate issue-to-pr instruction**

```yaml
id: issue-to-pr
revision: 1
source_kind: issue
mode: mutate
context:
  include_issue_body: true
  include_issue_comments: true
  include_linked_prs: true
permissions:
  code_read: true
  code_write: true
  git_push: true
  pr_create: true
  pr_update: true
  comment_write: true
github_actions:
  - branch_push
  - pr_create
  - issue_comment
execution:
  agent: codex-cli
  timeout_sec: 3600
```

- [ ] **Step 3: Add the observe-only pull request review instruction**

```yaml
id: pr-review-comment
revision: 1
source_kind: pull_request
mode: observe
context:
  include_pr_body: true
  include_pr_comments: true
  include_pr_diff: true
permissions:
  code_read: true
  code_write: false
  git_push: false
  pr_create: false
  pr_update: false
  comment_write: true
github_actions:
  - pull_request_comment
execution:
  agent: codex-cli
  timeout_sec: 1800
```

### Task 3: Create Core Domain Types And Service Boundaries

**Files:**
- Create: `src/domain/task.ts`
- Create: `src/domain/instruction.ts`
- Create: `src/domain/task-status.ts`
- Create: `src/services/enqueue-service.ts`
- Create: `src/services/scheduler-service.ts`
- Create: `src/services/execution-service.ts`

- [ ] **Step 1: Add task status definitions**

```ts
export const TASK_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "superseded",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
```

- [ ] **Step 2: Add core task and source types**

```ts
import type { TaskStatus } from "./task-status.js";

export type SourceKind = "issue" | "pull_request";

export interface RepoRef {
  owner: string;
  name: string;
}

export interface SourceRef {
  kind: SourceKind;
  number: number;
}

export interface TaskRecord {
  taskId: string;
  repo: RepoRef;
  source: SourceRef;
  instructionId: string;
  status: TaskStatus;
  priority: "normal";
  requestedBy: string;
  createdAt: string;
}
```

- [ ] **Step 3: Add instruction type definitions**

```ts
import type { SourceKind } from "./task.js";

export type ExecutionMode = "observe" | "mutate";

export interface InstructionDefinition {
  id: string;
  revision: number;
  sourceKind: SourceKind;
  mode: ExecutionMode;
  githubActions: string[];
  execution: {
    agent: string;
    timeoutSec: number;
  };
}
```

- [ ] **Step 4: Add empty service boundaries that can be filled later**

```ts
export class EnqueueService {}
export class SchedulerService {}
export class ExecutionService {}
```

### Task 4: Create Adapter Skeletons For Queue, Logs, GitHub, And Workspaces

**Files:**
- Create: `src/infra/queue/queue-store.ts`
- Create: `src/infra/logs/log-store.ts`
- Create: `src/infra/github/github-client.ts`
- Create: `src/infra/workspaces/workspace-manager.ts`
- Create: `src/cli/main.ts`
- Create: `src/cli/enqueue-command.ts`
- Create: `src/daemon/runner-daemon.ts`
- Create: `src/index.ts`
- Create: `tests/unit/.gitkeep`

- [ ] **Step 1: Add queue and log store interfaces**

```ts
import type { TaskRecord } from "../../domain/task.js";

export interface QueueStore {
  enqueue(task: TaskRecord): Promise<void>;
}
```

```ts
export interface LogStore {
  write(taskId: string, message: string): Promise<void>;
}
```

- [ ] **Step 2: Add GitHub and workspace interfaces**

```ts
export interface GitHubClient {}
```

```ts
export interface WorkspaceManager {}
```

- [ ] **Step 3: Add CLI and daemon entrypoints**

```ts
export async function main(argv: string[]): Promise<void> {
  console.log("runner cli scaffold", argv);
}

void main(process.argv.slice(2));
```

```ts
export class RunnerDaemon {
  async start(): Promise<void> {
    console.log("runner daemon scaffold");
  }
}
```

```ts
import { RunnerDaemon } from "./daemon/runner-daemon.js";

const daemon = new RunnerDaemon();
void daemon.start();
```

- [ ] **Step 4: Reserve the test tree**

```text
tests/unit/.gitkeep
```

## Self-Review Checklist

- Spec coverage: this plan creates the initial structure for queueing, instructions, daemon execution, local logging, and GitHub integration boundaries
- Placeholder scan: no TBD markers or deferred pseudocode remain
- Type consistency: `instructionId`, `TaskRecord`, `ExecutionMode`, and `TaskStatus` stay consistent across planned files

## Immediate Execution Scope

For the current request, execute Task 1 through Task 4 as scaffold-only work. Do not implement queue behavior or GitHub runtime logic yet.
