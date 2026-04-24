# Enqueue Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the first working vertical slice that can resolve an instruction, enqueue a task into a local file-backed queue, and apply same-source supersede rules.

**Architecture:** This slice keeps the system local and dependency-light. A YAML-backed instruction loader resolves the latest instruction definition from `definitions/instructions`, and a file-backed queue store persists task records under `var/queue`. The enqueue service coordinates validation and storage, while the CLI wires the pieces together for local invocation.

**Tech Stack:** Node.js, TypeScript, Vitest, YAML, local filesystem persistence

---

## Planned File Structure

- Modify: `package.json`
- Create: `src/domain/queue-task.ts`
- Modify: `src/domain/instruction.ts`
- Create: `src/infra/instructions/instruction-loader.ts`
- Modify: `src/infra/queue/queue-store.ts`
- Create: `src/infra/queue/file-queue-store.ts`
- Modify: `src/services/enqueue-service.ts`
- Modify: `src/cli/enqueue-command.ts`
- Modify: `src/cli/main.ts`
- Create: `tests/unit/instruction-loader.test.ts`
- Create: `tests/unit/file-queue-store.test.ts`
- Create: `tests/unit/enqueue-service.test.ts`

### Task 1: Add Failing Tests For Instruction Loading

**Files:**
- Create: `tests/unit/instruction-loader.test.ts`
- Create: `src/infra/instructions/instruction-loader.ts`
- Modify: `src/domain/instruction.ts`

- [ ] **Step 1: Write the failing instruction loader test**

```ts
import { describe, expect, test } from "vitest";
import { loadInstructionDefinition } from "../../src/infra/instructions/instruction-loader.js";

describe("loadInstructionDefinition", () => {
  test("loads and maps the issue-to-pr instruction", async () => {
    const instruction = await loadInstructionDefinition({
      definitionsDir: "definitions/instructions",
      instructionId: "issue-to-pr",
    });

    expect(instruction.id).toBe("issue-to-pr");
    expect(instruction.revision).toBe(1);
    expect(instruction.sourceKind).toBe("issue");
    expect(instruction.mode).toBe("mutate");
    expect(instruction.permissions.codeWrite).toBe(true);
    expect(instruction.githubActions).toEqual([
      "branch_push",
      "pr_create",
      "issue_comment",
    ]);
  });
});
```

- [ ] **Step 2: Run the instruction loader test and verify it fails**

Run: `powershell -ExecutionPolicy Bypass -File .\tools\npm.ps1 run test -- tests/unit/instruction-loader.test.ts`
Expected: FAIL because `instruction-loader.ts` does not exist yet or does not export `loadInstructionDefinition`

- [ ] **Step 3: Implement the minimal loader and instruction types**

Add a YAML-backed loader that resolves `<definitionsDir>/<instructionId>.yaml`, parses the file, and maps snake_case YAML fields to the TypeScript `InstructionDefinition` shape.

- [ ] **Step 4: Run the instruction loader test and verify it passes**

Run: `powershell -ExecutionPolicy Bypass -File .\tools\npm.ps1 run test -- tests/unit/instruction-loader.test.ts`
Expected: PASS

### Task 2: Add Failing Tests For The File Queue Store

**Files:**
- Create: `tests/unit/file-queue-store.test.ts`
- Create: `src/domain/queue-task.ts`
- Modify: `src/infra/queue/queue-store.ts`
- Create: `src/infra/queue/file-queue-store.ts`

- [ ] **Step 1: Write the failing queue store tests**

```ts
import { describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileQueueStore } from "../../src/infra/queue/file-queue-store.js";

describe("FileQueueStore", () => {
  test("enqueues a task as queued", async () => {
    const root = await mkdtemp(join(tmpdir(), "queue-store-"));
    const store = new FileQueueStore({ dataDir: root });

    const task = await store.enqueue({
      repo: { owner: "octo", name: "repo" },
      source: { kind: "issue", number: 100 },
      instructionId: "issue-to-pr",
      requestedBy: "test",
    });

    expect(task.status).toBe("queued");
    expect(task.source.number).toBe(100);

    await rm(root, { recursive: true, force: true });
  });

  test("supersedes older queued tasks for the same source", async () => {
    const root = await mkdtemp(join(tmpdir(), "queue-store-"));
    const store = new FileQueueStore({ dataDir: root });

    const first = await store.enqueue({
      repo: { owner: "octo", name: "repo" },
      source: { kind: "issue", number: 100 },
      instructionId: "issue-comment-opinion",
      requestedBy: "test",
    });

    const second = await store.enqueue({
      repo: { owner: "octo", name: "repo" },
      source: { kind: "issue", number: 100 },
      instructionId: "issue-to-pr",
      requestedBy: "test",
    });

    const tasks = await store.listTasks();
    const reloadedFirst = tasks.find((task) => task.taskId === first.taskId);
    const reloadedSecond = tasks.find((task) => task.taskId === second.taskId);

    expect(reloadedFirst?.status).toBe("superseded");
    expect(reloadedSecond?.status).toBe("queued");

    await rm(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the queue store tests and verify they fail**

Run: `powershell -ExecutionPolicy Bypass -File .\tools\npm.ps1 run test -- tests/unit/file-queue-store.test.ts`
Expected: FAIL because `FileQueueStore` and the concrete queue API do not exist yet

- [ ] **Step 3: Implement the minimal file-backed queue store**

Store tasks in a JSON file under the configured data directory, generate a task id, and apply same-source supersede rules only to tasks in `queued` status.

- [ ] **Step 4: Run the queue store tests and verify they pass**

Run: `powershell -ExecutionPolicy Bypass -File .\tools\npm.ps1 run test -- tests/unit/file-queue-store.test.ts`
Expected: PASS

### Task 3: Add Failing Tests For The Enqueue Service

**Files:**
- Create: `tests/unit/enqueue-service.test.ts`
- Modify: `src/services/enqueue-service.ts`
- Modify: `src/cli/enqueue-command.ts`

- [ ] **Step 1: Write the failing enqueue service tests**

```ts
import { describe, expect, test } from "vitest";
import { EnqueueService } from "../../src/services/enqueue-service.js";

describe("EnqueueService", () => {
  test("rejects a source kind mismatch", async () => {
    const service = new EnqueueService({
      instructionLoader: {
        loadById: async () => ({
          id: "issue-to-pr",
          revision: 1,
          sourceKind: "issue",
          mode: "mutate",
          permissions: {
            codeRead: true,
            codeWrite: true,
            gitPush: true,
            prCreate: true,
            prUpdate: true,
            commentWrite: true,
          },
          githubActions: ["branch_push", "pr_create", "issue_comment"],
          execution: {
            agent: "codex-cli",
            timeoutSec: 3600,
          },
        }),
      },
      queueStore: {
        enqueue: async () => {
          throw new Error("should not be called");
        },
      },
    });

    await expect(
      service.enqueue({
        repo: { owner: "octo", name: "repo" },
        source: { kind: "pull_request", number: 52 },
        instructionId: "issue-to-pr",
        requestedBy: "test",
      }),
    ).rejects.toThrow("source kind");
  });
});
```

- [ ] **Step 2: Run the enqueue service tests and verify they fail**

Run: `powershell -ExecutionPolicy Bypass -File .\tools\npm.ps1 run test -- tests/unit/enqueue-service.test.ts`
Expected: FAIL because `EnqueueService` does not yet accept dependencies or enforce instruction/source compatibility

- [ ] **Step 3: Implement the minimal enqueue service and CLI wiring**

Make the service load the instruction, validate the source kind, and delegate to the queue store. Update the CLI to instantiate the file queue store and instruction loader, then print a compact success message with the task id.

- [ ] **Step 4: Run the enqueue service test and targeted CLI build verification**

Run: `powershell -ExecutionPolicy Bypass -File .\tools\npm.ps1 run test -- tests/unit/enqueue-service.test.ts`
Expected: PASS

Run: `powershell -ExecutionPolicy Bypass -File .\tools\npm.ps1 run build`
Expected: PASS

## Self-Review Checklist

- Spec coverage: this slice covers instruction resolution, queue insertion, and queued-task supersede semantics
- Placeholder scan: no deferred implementation markers are part of the plan
- Type consistency: `InstructionDefinition`, `TaskRecord`, and queue insertion input stay aligned across files

## Immediate Execution Scope

Execute all three tasks inline in the current session.
