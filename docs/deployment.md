# Deployment

Single Oracle VM deployment of the runner. Two long-running processes:

- `oh-my-github-runner.service` — Node.js daemon (queue + webhook server,
  bound to `127.0.0.1:${WEBHOOK_PORT}`)
- `cloudflared.service` — Cloudflare tunnel that exposes
  `https://<your-runner-host>` to the runner's local port

The runner runs as the existing `ubuntu` system user. Code lives under
that user's home directory; secrets live under `/etc`.

## Prerequisites

- Ubuntu host with Node.js >= 20 installed
- `git` available on `$PATH`
- A GitHub App with:
  - Permissions: Issues (RW), Pull requests (RW), Contents (RW), Metadata (R)
  - Subscribed events: Issues, Issue comment, Pull request review comment
  - Webhook URL: `https://<your-runner-host>/webhook`
  - Webhook secret: any random string (saved as `GITHUB_WEBHOOK_SECRET`)
  - Private key downloaded to `/etc/oh-my-github-runner/github-app.pem`
- `cloudflared` installed and authenticated against your DNS zone,
  with a tunnel created
- Tailscale up on the VM with `--ssh --advertise-tags=tag:server`

## Layout

```
/home/ubuntu/runner-deploy/              # deploy clone — what systemd runs;
                                         # owns dist/ and var/ (queue, logs,
                                         # repo mirrors, workspaces)
/home/ubuntu/oh-my-github-runner/        # (optional) dev clone — where you
                                         # edit code; not touched by deploy
/etc/oh-my-github-runner/runner.env      # env file (see .env.example)
/etc/oh-my-github-runner/github-app.pem  # GitHub App private key
/etc/cloudflared/config.yml              # tunnel ingress
```

The dev clone is optional — only the `runner-deploy` clone has to exist on
the VM. Splitting them keeps editor / linter / build artifacts isolated
from the running daemon and prevents `git reset --hard` (run by the deploy
script) from clobbering an in-progress edit.

## Install

```sh
sudo mkdir -p /etc/oh-my-github-runner

# fetch + first build (deploy clone)
git clone https://github.com/SanGyuk-Raccoon/oh-my-github-runner.git \
  /home/ubuntu/runner-deploy
cd /home/ubuntu/runner-deploy
npm ci
npm run compile

# env file
sudo cp .env.example /etc/oh-my-github-runner/runner.env
sudo chmod 640 /etc/oh-my-github-runner/runner.env
sudo chown root:ubuntu /etc/oh-my-github-runner/runner.env
sudo $EDITOR /etc/oh-my-github-runner/runner.env

# private key (upload from local first via scp or paste-in)
sudo chmod 640 /etc/oh-my-github-runner/github-app.pem
sudo chown root:ubuntu /etc/oh-my-github-runner/github-app.pem

# systemd
sudo cp ops/systemd/oh-my-github-runner.service /etc/systemd/system/
sudo cp ops/systemd/cloudflared.service /etc/systemd/system/
sudo cp ops/cloudflared/config.example.yml /etc/cloudflared/config.yml
sudo $EDITOR /etc/cloudflared/config.yml   # fill in <TUNNEL_UUID>
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared.service oh-my-github-runner.service
```

## Required env vars

See [.env.example](../.env.example). The runner refuses to start if any of
the following are missing:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY_PATH`
- `GITHUB_WEBHOOK_SECRET`
- `AGENTS` (comma-separated list, e.g. `claude`)
- `<AGENT>_COMMAND` for each entry in `AGENTS`
- `ALLOWED_SENDER_IDS` (comma-separated GitHub user IDs allowed to trigger
  tasks via webhook; events from any other sender are dropped before
  enqueue. Look up an id with `gh api /users/<login> --jq .id`.)

## State files

- `var/queue/tasks.json` — durable queue of tasks
- `var/queue/state.json` — per-agent rate-limit `pausedUntil`; deleting this
  file is the manual override to resume queued work immediately
- `var/repos/<owner>/<name>/mirror.git` — bare mirror per repo (cached
  across tasks)
- `var/workspaces/<task-id>/` — per-task working tree (created and removed
  per task)
- `var/logs/<task-id>.log` — per-task log line history

## Verifying the tunnel

```sh
curl -i -X POST https://<your-runner-host>/webhook
# Expect: HTTP/2 401 (no signature) — confirms the request reached Node.js
```

A 200 with body `ignored` to a webhook the runner cannot route also confirms
end-to-end signing path.

## Continuous deployment via GitHub Actions + Tailscale SSH

`push` to `main` triggers `.github/workflows/deploy.yml`, which brings up
an ephemeral Tailscale node (`tag:gh-deploy`) and SSHes into the VM
(`tag:server`) over **Tailscale SSH** — no SSH keys are managed in
GitHub, the tailnet ACL handles the auth. On the VM, the workflow runs
`ops/scripts/deploy.sh` which fetches `origin/main`, no-ops if the head
already matches, otherwise resets, reinstalls runtime dependencies,
recompiles, and restarts the service. Build failures abort the deploy
without touching the running daemon.

### One-time VM setup

```sh
# 1) Tailscale + Tailscale SSH (so the tailnet identity authenticates SSH)
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --advertise-tags=tag:server

# 2) Sudoers — ubuntu only needs to restart the runner service
sudo install -m 440 /dev/stdin /etc/sudoers.d/oh-my-github-runner-deploy <<'SUDO'
ubuntu ALL=(root) NOPASSWD: /bin/systemctl restart oh-my-github-runner.service
SUDO
sudo visudo -c   # syntax check; non-zero exit = revert above
```

### One-time GitHub setup

Repository → Settings → Secrets and variables → Actions → Secrets:

- `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET` — from Tailscale admin →
  OAuth clients (scope `tag:gh-deploy`)

Hostname (`ubuntu@github-runner`) is hardcoded in
`.github/workflows/deploy.yml`; if the VM is renamed or the SSH login
changes, edit the workflow.

Tailnet ACL must allow `tag:gh-deploy` → `tag:server` over SSH and
permit `ubuntu` under Tailscale SSH (`autogroup:nonroot` or explicit
`ubuntu`). Both tags reuse the tailnet's existing definitions; no new
tags are introduced for this repo.

### Verifying the deploy

```sh
# After pushing to main, watch the workflow run, then on the VM:
journalctl -u oh-my-github-runner.service -n 50 -f
git -C /home/ubuntu/runner-deploy log -1 --format='%h %s'
```

If the deploy script no-ops because the VM is already at the requested
commit (e.g., a manual `git pull` ran first), the workflow logs
`Already at <sha>; nothing to deploy.` and exits 0. The service is
left untouched.

## Working on the runner from the VM

```
/home/ubuntu/runner-deploy/        # what systemd runs — do NOT edit by hand
/home/ubuntu/oh-my-github-runner/  # dev clone (optional) — edit here
```

The deploy script `git reset --hard origin/main` on `runner-deploy`
unconditionally on every run, so any uncommitted edit there is lost.
Edit code in the dev clone (or off the VM entirely), commit, push,
let the workflow propagate it. The dev clone exists only because Claude
Code runs on this VM; if you operate from a laptop you can skip it.

## Operational tips

- Logs: `journalctl -u oh-my-github-runner.service -f`
- Tunnel logs: `journalctl -u cloudflared.service -f`
- Current commit on the VM: `git -C /home/ubuntu/runner-deploy log -1 --oneline`
- Manual rate-limit reset: `rm /home/ubuntu/runner-deploy/var/queue/state.json`
- Recovery from crash: `recoverRunningTasks` runs at startup and marks
  in-flight tasks as failed. The daemon's `notifyTaskFailure` callback
  posts a `Task <id> failed before completion: <summary>` comment to the
  originating issue or PR. Orphaned workspaces under `var/workspaces/`
  are not cleaned automatically in v1.
- Manual deploy: `ssh ubuntu@github-runner 'bash /home/ubuntu/runner-deploy/ops/scripts/deploy.sh'`
- When deploying a change that bumps an instruction `revision` in
  `definitions/instructions/*.yaml`, prefer to deploy when the queue is
  empty (`jq '[.[] | select(.status=="running" or .status=="queued")] | length' var/queue/tasks.json`).
  In-flight tasks pinned to the old revision will keep running with the
  old prompt; new tasks pick up the new revision.

## Recommended GitHub setup (not enforced by code)

- **Branch protection on `main`**: require pull request, disallow direct
  push, disallow force push. The runner never pushes directly to `main`
  (`buildBranchName` always produces `ai/<kind>-<number>`), but server-
  side branch protection is the backstop if a future change to the
  runner ever forgets that invariant.
- **Required status checks on PRs**: none in v1; build/test runs
  locally on the VM only at deploy time.
