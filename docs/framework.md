# Framework guide

Hint sheet for code that isn't self-evident. Types and signatures live in code — see `src/strategies/types.ts` for the contract.

## Model

- `enqueue (webhook) → FS queue → daemon → strategy.run(task, toolkit, signal)`
- You write a **strategy**. The framework owns enqueue/queue/daemon/toolkit/tool routing.
- Strategy uses **only** the toolkit. Importing from `src/infra/**` is a layering break.

## Add an instruction

1. `src/strategies/<id>.ts` — implement `Strategy` (`src/strategies/types.ts`).
2. Register in the Map at `src/strategies/index.ts` (key MUST equal the `instructionId` used at enqueue).
3. If a webhook event should produce this id, wire it in `src/services/event-dispatcher.ts`.

## Add an AI tool

1. `<NAME>_COMMAND` env var (binary path).
2. New `<Name>ToolRunner` class under `src/infra/tool/` implementing `ToolRunner` (`src/domain/ports/tool-runner.ts`). Owns argv, permission translation, rate-limit patterns, and `cleanupArtifacts`.
3. Wire it in `src/index.ts` — push a `{ name, runner }` entry into `toolEntries` when the env var is set.

## AI permission vocabulary

`AiRunOptions.allowedTools` and `disallowedTools` use a portable spec, not any one tool's syntax. Each `ToolRunner` translates.

```
read, grep, glob, edit, write   built-in capabilities
shell:<token-prefix>            shell command prefix (whitespace-tokenized)
```

Allow-list is default-deny; everything not listed is implicitly forbidden. Use `disallowedTools` only when you need a narrow carve-out from a broad allow (e.g. allow `shell:gh` but block `shell:gh pr merge`). See `src/strategies/_shared/tool-presets.ts` for the canonical sets.

## Strategy invariants

- Call `tk.workspace.prepare*` and `tk.github.fetchContext` **before** `tk.ai.run`. Out of order = runtime failure.
- Call `signal.throwIfAborted()` between awaits, otherwise `supersede` can't unwind cleanly.
- Hold workspaces with `await using` — disposal cleans the branch and tool artifacts.
- Declare the tools the strategy may use in `policies.uses` (e.g. `{ claude: true, gemini: true }`). The toolkit refuses any `tk.ai.run({ tool })` not in that set; if `policies.uses` has a single tool, `opts.tool` is optional and inferred.

## Prompt fragments

- Live under `definitions/prompts/{_common,personas,modes,guidance}/<name>.md`.
- Strategies reference them by string path (`{ kind: "file", path: "personas/architecture" }`). Mistype = runtime error.

## `var/` layout (runtime state, written by daemon)

- `queue/`        — task records (one file per task; directory encodes status)
- `logs/`         — per-task log files
- `repos/`        — bare clones (cache)
- `workspaces/`   — per-task work dirs; janitor cleans orphans on boot
