# Deployment

Single Oracle VM deployment of the runner. Two long-running processes:

> Forking this repo? See [Forking checklist](#forking-checklist) at the
> bottom for the short list of values you must replace before the
> runner can serve your account.

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
# Replace <your-fork> with the GitHub owner of the fork the VM should track.
git clone https://github.com/<your-fork>/oh-my-github-runner.git \
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
- `TOOLS` (comma-separated list, e.g. `claude`)
- `<TOOL>_COMMAND` (binary path) for each entry in `TOOLS`. The argv passed
  to the binary lives in `definitions/tools/<name>.yaml`, not env.
- `ALLOWED_SENDER_IDS` (comma-separated GitHub user IDs allowed to trigger
  tasks via webhook; events from any other sender are dropped before
  enqueue. Look up an id with `gh api /users/<login> --jq .id`.)

## State files

- `var/queue/<status>/<taskId>.json` — one file per task. Status is encoded
  by directory: `queued/`, `running/`, `succeeded/`, `failed/`,
  `superseded/`. Transitions are atomic cross-directory `rename(2)` calls,
  so a task lives in exactly one directory at any observable moment.
  `succeeded/`, `failed/`, `superseded/` are pruned by mtime; the daemon
  runs a sweep on boot and every 24h, retaining files for
  `RUNNER_QUEUE_RETENTION_DAYS` (default 7).
- `var/queue/state.json` — per-tool rate-limit `pausedUntil`; deleting this
  file is the manual override to resume queued work immediately
- `var/repos/<owner>/<name>/mirror.git` — bare mirror per repo (cached
  across tasks)
- `var/workspaces/<task-id>/` — per-task working tree (created and removed
  per task)
- `var/logs/<task-id>.log` — per-task log line history
- `~/.claude/projects/<encoded-cwd>/` — claude CLI transcript / subagent
  logs / per-cwd memory dropped by the tool CLI itself. The runner
  deletes the per-task directory in the same `finally` block that removes
  the workspace; `CLAUDE_HOME` overrides `~/.claude` for tests or alt
  layouts. Pre-existing accumulation can be one-shot cleaned with
  `rm -rf ~/.claude/projects/-home-ubuntu-runner-deploy-var-workspaces-task-*`.

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

Hostname (`ubuntu@github-runner`) is hardcoded on
[`.github/workflows/deploy.yml:40`](../.github/workflows/deploy.yml);
if the VM is renamed, the SSH login changes, or you are forking this
repo, edit that line to your `<ssh-user>@<tailnet-host>` (or pull it
out into a `vars.DEPLOY_SSH_TARGET` repo variable — see the
[Forking checklist](#forking-checklist)).

Tailnet ACL must allow `tag:gh-deploy` → `tag:server` over SSH and
permit the SSH login user under Tailscale SSH (`autogroup:nonroot` or
explicit `ubuntu`). Both tags reuse the tailnet's existing
definitions; no new tags are introduced for this repo.

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
  are not cleaned automatically in v1. Note: `deploy.sh` now waits for
  running tasks to drain before reset/restart, so the normal push flow
  no longer trips this path; `recoverRunningTasks` is reserved for actual
  crashes.
- Manual deploy: `ssh ubuntu@github-runner 'bash /home/ubuntu/runner-deploy/ops/scripts/deploy.sh'` (replace the `ubuntu@github-runner` host with your VM's tailnet target if you forked)
- Deploy waits for running tasks to drain before resetting and restarting
  (counts files in `var/queue/running/`, polling every 5s, override via
  `RUNNER_DEPLOY_POLL_SEC`). The wait has no internal timeout — the
  GitHub Actions workflow `timeout-minutes` (15) is the only outer bound;
  if the wait exceeds it, the SSH session is killed and the next push
  retries. `queued` tasks are unaffected — they survive the restart and
  resume from the new code. Strategy code changes follow the same flow:
  in-flight tasks finish on the old strategy code (loaded into the running
  process), new tasks pick up the new code after the daemon restarts.
- Tweak retention for terminal tasks with `RUNNER_QUEUE_RETENTION_DAYS`
  (default 7). Files under `var/queue/{succeeded,failed,superseded}/` older
  than the cutoff are removed by the daemon at boot and every 24h.

## Recommended GitHub setup (not enforced by code)

- **Branch protection on `main`**: require pull request, disallow direct
  push, disallow force push. The runner never pushes directly to `main`
  (`buildBranchName` always produces `ai/<kind>-<number>`), but server-
  side branch protection is the backstop if a future change to the
  runner ever forgets that invariant.
- **Required status checks on PRs**: none in v1; build/test runs
  locally on the VM only at deploy time.

## Forking checklist

The runner does not bake any owner/repo identity into `src/` — webhook
payloads supply the repo at runtime. To run your own copy you only have
to:

1. **Fork** this repository to your own GitHub account/org.
2. **Create a new GitHub App** under your account with the permissions
   and event subscriptions listed in [Prerequisites](#prerequisites).
   Webhook URL: `https://<your-runner-host>/webhook`. Save the App ID,
   webhook secret, and `.pem` private key.
3. **Install the App** on every repo you want the runner to serve.
4. **Provision the VM** (Ubuntu + Node 20 + git + cloudflared + the
   tool CLI such as `claude`). Bring it up on your tailnet with
   `tailscale up --ssh --advertise-tags=tag:server`.
5. **Cloudflare tunnel + DNS** for `<your-runner-host>` per
   [`ops/cloudflared/config.example.yml`](../ops/cloudflared/config.example.yml).
6. **Fill `/etc/oh-my-github-runner/runner.env`** from
   [`.env.example`](../.env.example) with your `GITHUB_APP_ID`,
   `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_WEBHOOK_SECRET`,
   `ALLOWED_SENDER_IDS` (your GitHub user id — find it with
   `gh api /users/<login> --jq .id`), and the per-tool command path
   (`<TOOL>_COMMAND`).
7. **Set repo Secrets** for the deploy workflow:
   - `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`
8. **Update the SSH target** on
   [`.github/workflows/deploy.yml:40`](../.github/workflows/deploy.yml)
   from `ubuntu@github-runner` to your `<ssh-user>@<tailnet-host>`.
   (Recommended one-time refactor: replace that literal with
   `${{ vars.DEPLOY_SSH_TARGET || 'ubuntu@github-runner' }}` and set a
   `DEPLOY_SSH_TARGET` repo variable; this keeps the original repo
   working and lets every subsequent fork override via a variable
   instead of editing the workflow. The current PR cannot make this
   change because the `oh-my-github-runner` GitHub App lacks the
   `workflows` permission.)
9. **Update the clone URL** in the install snippet above to point at
   your fork.

Nothing else in this repo embeds an owner/repo identity. The
integration test fixtures reference `nerd-animals/oh-my-github-runner`
but that string never reaches runtime — leave it as-is unless you want
to point the integration suite at your own test repo.
