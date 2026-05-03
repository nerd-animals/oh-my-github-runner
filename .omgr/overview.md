# Overview

`oh-my-github-runner` (omgr) is a single-owner, single-VM GitHub automation runner. A GitHub App webhook fires on issues / issue comments / PR review comments, the runner enqueues a task, and a daemon executes the task by clones-and-runs against the target repo using one of several AI tool CLIs (Claude / Codex / Gemini).

## Key terms

- **Task** — a single unit of work to run for a specific issue or PR. Persisted as a JSON file under `var/queue/<status>/`.
- **Strategy** — the per-instruction implementation. Decides what context to fetch, which persona/mode/tool to invoke, and what to publish back to GitHub. Lives under `src/strategies/`.
- **Instruction** — the routing key carried by a task (`issue-initial-review`, `issue-implement`, `pr-implement`, `pr-review-comment`, `issue-comment-reply`). One strategy per instruction.
- **Toolkit** — the per-task facade that strategies use. Wraps GitHub access, workspace lifecycle, AI invocation, and logging. Strategies must use only the toolkit; importing from `src/infra/**` is a layering break.
- **Persona / Mode** — markdown fragments under `definitions/prompts/{personas,modes}` that shape the AI invocation. Personas define the lens (architect, test, ops, …); modes define what the AI is allowed to do (collect-only / observe / mutate).
- **Tool runner** — adapter for one AI CLI (`claude`, `codex`, `gemini`). Owns argv, permission translation, and rate-limit pattern matching. Lives under `src/infra/tool/`.
- **Workspace** — a per-task throwaway clone under `var/workspaces/<task-id>/`. Strategies hold it via `await using` so disposal cleans branch state and tool artifacts.

## Operating model

- One repo owner, one VM, one daemon process. Throughput is intentionally small — the runner waits for ALL tools listed in a strategy's `policies.uses` to be clear of rate-limit before starting the task.
- The runner never pushes to `main`. Mutating strategies always work on `ai/<kind>-<number>` branches and open PRs. `main` is server-side protected.
- The agent is the source of judgment — it decides whether to push, open a PR, comment, etc. The runner is a thin shim around tool invocation and lifecycle.
