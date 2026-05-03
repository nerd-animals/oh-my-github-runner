# Deployment

Single Oracle VM. Two services: `oh-my-github-runner.service` (Node daemon) + `cloudflared.service` (tunnel). Both as `ubuntu`. Secrets under `/etc/oh-my-github-runner/`.

Full operator handbook: [`docs/deployment.md`](../docs/deployment.md). This file is the agent-facing crib.

## Two clones

- `/home/ubuntu/runner-deploy/` — what systemd runs. Owns `dist/` and `var/`. `git reset --hard origin/main` on every deploy — local edits lost.
- `/home/ubuntu/oh-my-github-runner/` — optional dev clone. Not touched by deploy.

## State (`var/`)

- `queue/<status>/<taskId>.json` — task records. Status = directory (`queued/`, `running/`, `succeeded/`, `failed/`, `superseded/`). Transitions = atomic cross-dir `rename(2)`.
- `queue/state.json` — per-tool rate-limit `pausedUntil`. Delete to resume now.
- `repos/<owner>/<name>/mirror.git` — cached bare mirrors.
- `workspaces/<task-id>/` — per-task tree. Removed on completion; orphans = crashed runs.
- `logs/<task-id>.log` — per-task log.

## CD

`push main` → `.github/workflows/deploy.yml` → ephemeral Tailscale node SSHes VM (`tag:server`, Tailscale SSH — no SSH keys in GitHub) → `ops/scripts/deploy.sh`: drain `var/queue/running/` (poll 5s, no internal timeout — bound by 15-min workflow), reset, reinstall, recompile, restart. Build failures abort without touching the running daemon. In-flight tasks finish on old code; queued tasks resume on new.

## Logs

- Daemon: `journalctl -u oh-my-github-runner.service -f`
- Tunnel: `journalctl -u cloudflared.service -f`
- Per-task: `var/logs/<task-id>.log`
- Claude transcript: `~/.claude/projects/<encoded-cwd>/` (cleaned with workspace)
- VM HEAD: `git -C /home/ubuntu/runner-deploy log -1 --oneline`

## Recovery

`recoverRunningTasks` runs at boot, marks `running/` files as failed (only path: daemon crash, since `deploy.sh` waits for drain). Failure callback posts "Task <id> failed before completion: <summary>" to issue/PR. Orphan workspaces under `var/workspaces/` not auto-cleaned in v1.

## Hard rules

- Don't touch `.github/workflows/**`, systemd units, or `ops/scripts/deploy.sh` unless the task explicitly asks. The omgr GitHub App lacks `workflows` permission — pushes touching `.github/workflows/**` will fail anyway.
- Never push `main` directly. `buildBranchName` produces `ai/<kind>-<number>`.
- Never echo secrets (token-shaped strings, `.pem` content, env values).
