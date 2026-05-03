# Architecture

TypeScript ESM project. Layered: **domain → services → infra → daemon → cli/index**. Higher layers depend on lower; reverse imports are layering breaks.

## Layers

- `src/domain/` — pure types and rules. No IO. Files: `task.ts`, `github.ts`, `tool.ts`, `queue-task.ts`, `task-status.ts`, `rules/*.ts`, `ports/*.ts`.
- `src/domain/ports/` — interfaces that infra implements. The seam between business logic and IO. `github-client.ts`, `workspace-manager.ts`, `tool-runner.ts`, `queue-store.ts`, `log-store.ts`, `process-runner.ts`.
- `src/services/` — orchestration. Composes ports into use cases. `enqueue-service.ts`, `event-dispatcher.ts`, `scheduler-service.ts`, `webhook-handler.ts`, `toolkit.ts`, `tool-registry.ts`, `sticky-comment.ts`.
- `src/infra/` — adapters that implement the ports. Subdirs by area: `github/`, `queue/`, `logs/`, `tool/`, `workspaces/`, `prompts/`, `webhook/`, `platform/`.
- `src/strategies/` — one file per instruction id. Each implements `Strategy` (`src/strategies/types.ts`). Use **only** the toolkit; never import from `src/infra/**`. Registered in the Map at `src/strategies/index.ts` (key MUST equal the `instructionId`).
- `src/daemon/runner-daemon.ts` — owns the queue loop: pulls queued tasks, runs the strategy, transitions status, applies rate-limit pause.
- `src/index.ts` — composition root. Wires env → infra → services → daemon. The only file that imports from every layer.
- `src/runtime.ts` — typed runtime config object passed through DI.

## Key abstractions

- **`Strategy`** (`src/strategies/types.ts`): `{ policies, run(task, toolkit, signal) }`. `policies.uses` declares which tools the strategy may call (the daemon defers the task until all are rate-limit-clear). `run` is async, must call `signal.throwIfAborted()` between awaits.
- **`Toolkit`** (`src/strategies/types.ts`): per-task facade exposing `github` / `workspace` / `ai` / `log`. The contract: call `tk.workspace.prepare*` and `tk.github.fetchContext` **before** `tk.ai.run`. Workspaces are held with `await using` and the toolkit remembers the active one to route AI invocations.
- **`PromptFragment`** (`src/strategies/types.ts`): tagged union for prompt assembly. Kinds: `file` (loads from `definitions/prompts/<subdir>/<name>.md` via the prompt cache), `literal`, `context` (renders a piece of the GitHub source context), `user` (additional task instructions).
- **`AiRunOptions.allowedTools` / `disallowedTools`**: portable permission vocabulary (`read`, `grep`, `glob`, `edit`, `write`, `shell:<token-prefix>`). Each `ToolRunner` translates to the underlying CLI's syntax. Canonical preset sets in `src/strategies/_shared/tool-presets.ts` (`OBSERVE_ALLOWED`, `COLLECT_ONLY_ALLOWED`, `MUTATE_ALLOWED`, `MUTATE_DISALLOWED`, `REPLY_DISALLOWED`).
- **`ToolRunner`** (`src/domain/ports/tool-runner.ts`): one per AI CLI. Receives translated permission set, prompt text, workspace path; returns `{ kind: "succeeded" | "failed" | "rate_limited" }`. Rate-limit detection is per-runner pattern matching against stderr/stdout.

## Flow

```
webhook → WebhookHandler → EventDispatcher → EnqueueService
       → FileQueueStore (var/queue/queued/<id>.json)
       → RunnerDaemon (poll loop)
       → Strategy.run(task, Toolkit, signal)
       →   tk.workspace.prepare* (clone target repo)
       →   tk.github.fetchContext (issue/PR body, comments, diff, linked refs)
       →   tk.ai.run (PromptRenderer.render → ToolRunner.run)
       →   tk.github.post* (comment / PR body)
       → status transition (running → succeeded / failed / superseded)
```

## Adding things

- **New instruction**: add `src/strategies/<id>.ts` implementing `Strategy`, register in `src/strategies/index.ts`, wire webhook → instruction in `src/services/event-dispatcher.ts`.
- **New AI tool**: add `<NAME>_COMMAND` env var, write `<Name>ToolRunner` under `src/infra/tool/` implementing `ToolRunner`, register in `src/index.ts` `toolEntries`.
- **New prompt fragment**: drop `definitions/prompts/<subdir>/<name>.md`. Reference via `{ kind: "file", path: "<subdir>/<name>" }` from a strategy.

## Hard rules

- Strategies never import from `src/infra/**`. If you need a new capability, add a method to the toolkit (or a new port) — don't reach around it.
- The daemon owns task status transitions. Strategies return `{ status: "succeeded" | "failed" | "rate_limited" }` only; they don't write queue files directly.
- `main` is protected server-side. Code shouldn't try to push to `main`; `buildBranchName(task)` always produces `ai/<kind>-<number>`.
