# Architecture

TypeScript ESM. Layers: **domain → services → infra → daemon → cli**. Reverse imports break layering.

## Module roles

- `domain/` — pure types/rules. No IO.
- `domain/ports/` — interfaces. The IO seam.
- `services/` — orchestration over ports.
- `infra/<area>/` — port adapters: `github/`, `queue/`, `logs/`, `tool/`, `workspaces/`, `prompts/`, `webhook/`, `platform/`.
- `strategies/<id>.ts` — one per instructionId. Use **only** Toolkit.
- `daemon/runner-daemon.ts` — queue loop. Owns status transitions.
- `index.ts` — composition root.

## Load-bearing types (`src/strategies/types.ts`)

- **`Strategy.policies.uses`** — set of tools. Daemon defers task until ALL clear of rate-limit.
- **`Strategy.run`** — must call `signal.throwIfAborted()` between awaits.
- **Toolkit contract** — `workspace.prepare*` AND `github.fetchContext` MUST run before `ai.run`. Workspaces held with `await using`.
- **`PromptFragment`** — kinds: `file`, `literal`, `context`, `user`, `omgr-doc`.
- **`AiRunOptions.allowed/disallowedTools`** — portable vocab: `read`, `grep`, `glob`, `edit`, `write`, `shell:<token-prefix>`. Each `ToolRunner` translates. Presets: `src/strategies/_shared/tool-presets.ts` (`OBSERVE_ALLOWED`, `COLLECT_ONLY_ALLOWED`, `MUTATE_ALLOWED`, `MUTATE_DISALLOWED`, `REPLY_DISALLOWED`).

## Flow

webhook → WebhookHandler → EventDispatcher → EnqueueService → FileQueueStore → RunnerDaemon → `Strategy.run` → (workspace.prepare*, github.fetchContext, ai.run, github.post*) → status transition

## Adding

- **Instruction**: `src/strategies/<id>.ts` + register in `src/strategies/index.ts` + wire event in `src/services/event-dispatcher.ts`.
- **AI tool**: `<NAME>_COMMAND` env + `<Name>ToolRunner` in `src/infra/tool/` + register in `src/index.ts` `toolEntries`.
- **Prompt fragment**: drop md at `definitions/prompts/<sub>/<name>.md`, reference via `{ kind: "file", path: "<sub>/<name>" }`.
- **Strategy guide**: `.omgr/strategy-development.md` — high-level responsibility and design guidance for instruction Strategies.

## Hard rules

- Strategies never import `src/infra/**`. Need a capability? Add to toolkit (or a new port).
- Daemon owns status. Strategies return `{ status }` only — never write queue files directly.
- Never push `main` (server-side protected). `buildBranchName(task)` produces `ai/<kind>-<number>`.
