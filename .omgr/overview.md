# Overview

Single-owner, single-VM GitHub automation runner. Webhook → enqueue → daemon → clone target repo → run AI tool CLI (claude/codex/gemini) → post back.

## Terms

- **Task** — unit of work. JSON under `var/queue/<status>/`.
- **Strategy** — per-instruction logic. `src/strategies/<id>.ts`. One per instructionId.
- **Instruction** — routing key: `issue-initial-review`, `issue-implement`, `pr-implement`, `pr-review-comment`, `issue-comment-reply`.
- **Toolkit** — per-task facade (`github` / `workspace` / `ai` / `log`). Strategies use only this — never import `src/infra/**`.
- **Persona / Mode** — md under `definitions/prompts/{personas,modes}`. Persona = lens; Mode = permission preset.
- **ToolRunner** — adapter for one CLI. `src/infra/tool/`. Owns argv, permission translation, rate-limit detection.
- **Workspace** — throwaway clone at `var/workspaces/<task-id>/`. Held with `await using`.

## Model

- One owner, one VM, one daemon. Throughput intentionally small.
- Daemon defers a task until ALL tools in `policies.uses` are rate-limit-clear.
- Never pushes `main` (server-side protected). Mutating strategies → `ai/<kind>-<number>` branches → PRs.
- Agent owns judgment (push/PR/comment). Runner is a thin shim.
