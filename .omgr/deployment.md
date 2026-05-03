# Deployment

Single Oracle VM. Two systemd services:

- `oh-my-github-runner.service` — Node.js daemon (queue + webhook server, bound to `127.0.0.1:${WEBHOOK_PORT}`).
- `cloudflared.service` — Cloudflare tunnel exposing `https://<runner-host>` to the local port.

Both run as the `ubuntu` user. Code lives under `/home/ubuntu/`; secrets under `/etc/oh-my-github-runner/`.

The full operator handbook (env vars, GitHub App setup, tunnel verification, deploy workflow, forking) is in [`docs/deployment.md`](../docs/deployment.md). This file is the agent-facing crib sheet — for human operator steps, prefer `docs/deployment.md` and link to it.

## Two clones on the VM

- `/home/ubuntu/runner-deploy/` — what systemd runs. Owns `dist/` and `var/`. The deploy script `git reset --hard origin/main` on every push, so any local edit here is lost.
- `/home/ubuntu/oh-my-github-runner/` — optional dev clone for editing on the VM. Not touched by the deploy script.

If you (the agent) are running inside the deploy clone, treat its working tree as throwaway between deploys; if running inside the dev clone, edits persist until committed.

## State directories (`var/`)

- `var/queue/<status>/<taskId>.json` — task records. Status encoded by directory: `queued/`, `running/`, `succeeded/`, `failed/`, `superseded/`. Transitions are atomic cross-directory `rename(2)`; a task is in exactly one directory at any moment.
- `var/queue/state.json` — per-tool rate-limit `pausedUntil`. Deleting this file is the manual "resume now" override.
- `var/repos/<owner>/<name>/mirror.git` — bare mirror per repo, cached across tasks.
- `var/workspaces/<task-id>/` — per-task working tree. Removed on task completion; orphans on the deploy clone come from crashed runs.
- `var/logs/<task-id>.log` — per-task log line history.

## Continuous deployment

`push` to `main` triggers `.github/workflows/deploy.yml`: an ephemeral Tailscale node SSHes into the VM (`tag:server`) using **Tailscale SSH** (no SSH keys in GitHub) and runs `ops/scripts/deploy.sh`. The script waits for `var/queue/running/` to drain (poll every 5s, no internal timeout — bounded by the workflow's 15-minute `timeout-minutes`), then resets, reinstalls deps, recompiles, restarts the service. Build failures abort the deploy without touching the running daemon.

In-flight tasks finish on the old code (already loaded into the running process); `queued` tasks survive the restart and resume on the new code.

## Observability

- Daemon logs: `journalctl -u oh-my-github-runner.service -f`
- Tunnel logs: `journalctl -u cloudflared.service -f`
- Current commit on the VM: `git -C /home/ubuntu/runner-deploy log -1 --oneline`
- Per-task log: `var/logs/<task-id>.log`
- Per-task transcript (claude tool): `~/.claude/projects/<encoded-cwd>/` (cleaned in the same `finally` that removes the workspace)

## Recovery

`recoverRunningTasks` runs at daemon boot and marks any `running/` files as failed (a daemon crash is the only way for them to be there once `deploy.sh` waits for drain). The failure callback posts a "Task <id> failed before completion: <summary>" comment on the originating issue/PR. Orphaned workspace directories under `var/workspaces/` are not auto-cleaned in v1.

## Hard rules for changes

- Never modify CI workflows (`.github/workflows/**`), systemd units, or `ops/scripts/deploy.sh` unless the task explicitly asks for it. The GitHub App for omgr lacks the `workflows` permission, so PRs that touch `.github/workflows/**` will fail to push from inside an agent run anyway.
- Never push directly to `main` — it's branch-protected and the runner's branch naming (`buildBranchName`) always produces `ai/<kind>-<number>`.
- Never echo secrets (token-shaped strings, `.pem` content, env values) into output, code, or commit messages.
