# Deployment

Single Oracle VM deployment of the runner. Two long-running processes:

- `oh-my-github-runner.service` — Node.js daemon (queue + webhook server,
  bound to `127.0.0.1:${WEBHOOK_PORT}`)
- `cloudflared.service` — Cloudflare tunnel that exposes
  `https://oh-my-github-runner.darakbox.com` to the runner's local port

## Prerequisites

- Ubuntu host with Node.js >= 20 installed
- `git` available on `$PATH` for the runner user
- A GitHub App with:
  - Permissions: Issues (RW), Pull requests (RW), Contents (RW), Metadata (R)
  - Subscribed events: Issues, Issue comment, Pull request review comment
  - Webhook URL: `https://oh-my-github-runner.darakbox.com/webhook`
  - Webhook secret: any random string (saved as `GITHUB_WEBHOOK_SECRET`)
  - Private key downloaded to `/etc/oh-my-github-runner/github-app.pem`
- `cloudflared` installed and authenticated against the
  `darakbox.com` zone, with a tunnel created

## Layout

```
/opt/oh-my-github-runner/current/   # checked-out source + dist/
/etc/oh-my-github-runner/runner.env # env file (see .env.example)
/etc/oh-my-github-runner/github-app.pem
/etc/cloudflared/config.yml         # tunnel ingress
/var/lib/oh-my-github-runner/var/   # if you prefer to host state outside the source tree
```

If you keep `var/` inside the source tree, ensure the `runner` system user
owns `/opt/oh-my-github-runner/current/var/`.

## Install

```sh
sudo useradd -r -s /usr/sbin/nologin runner
sudo mkdir -p /opt/oh-my-github-runner/current /etc/oh-my-github-runner
sudo chown runner:runner /opt/oh-my-github-runner/current

# fetch + build
sudo -u runner git clone https://github.com/nerd-animals/oh-my-github-runner.git \
  /opt/oh-my-github-runner/current
cd /opt/oh-my-github-runner/current
sudo -u runner npm ci
sudo -u runner npm run compile

# env file
sudo cp .env.example /etc/oh-my-github-runner/runner.env
sudo chmod 640 /etc/oh-my-github-runner/runner.env
sudo chown root:runner /etc/oh-my-github-runner/runner.env
sudo $EDITOR /etc/oh-my-github-runner/runner.env

# private key
sudo chmod 640 /etc/oh-my-github-runner/github-app.pem
sudo chown root:runner /etc/oh-my-github-runner/github-app.pem

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
- `ALLOWED_REPOS` (at least one entry)

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
curl -i -X POST https://oh-my-github-runner.darakbox.com/webhook
# Expect: HTTP/2 401 (no signature) — confirms the request reached Node.js
```

A 200 with body `ignored` to a webhook the runner cannot route also confirms
end-to-end signing path.

## Continuous deployment via GitHub Actions + Tailscale

`push` to `main` triggers `.github/workflows/deploy.yml`, which connects
to the tailnet, SSHes into the VM as the `deploy` user, and runs
`ops/scripts/deploy.sh`. The script does a git fetch, no-ops if the head
already matches `origin/main`, otherwise resets, reinstalls runtime
dependencies, recompiles, and restarts the service. Failures abort the
deploy without touching the running daemon.

### One-time VM setup

```sh
# 1) deploy user with no shell-access password
sudo useradd -m -s /bin/bash deploy
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh

# 2) trust the workflow's SSH key
sudo -u deploy tee /home/deploy/.ssh/authorized_keys >/dev/null <<'KEY'
ssh-ed25519 AAAA... github-actions-deploy
KEY
sudo chmod 600 /home/deploy/.ssh/authorized_keys

# 3) sudoers — deploy user can do exactly two things
sudo install -m 440 /dev/stdin /etc/sudoers.d/oh-my-github-runner-deploy <<'SUDO'
deploy ALL=(runner) NOPASSWD: /usr/bin/git, /usr/bin/npm
deploy ALL=(root)   NOPASSWD: /bin/systemctl restart oh-my-github-runner.service
SUDO
sudo visudo -c   # syntax check; non-zero exit = revert above

# 4) Tailscale on the VM (already tagged tag:server in this tailnet)
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh=false --advertise-tags=tag:server
```

### One-time GitHub setup

Repository → Settings:

- **Secrets**:
  - `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET` — from Tailscale admin →
    OAuth clients (scope `tag:gh-deploy`)
  - `SSH_PRIVATE_KEY` — the `deploy` user's ed25519 private key
    (`ssh-keygen -t ed25519`)
- **Variables**:
  - `SSH_HOST` — VM's MagicDNS name, e.g.
    `github-runner.tail-xxxx.ts.net`
  - `SSH_USER` — `deploy`

Tailnet ACL (existing tagOwners + ACL rule allowing `tag:gh-deploy` to
reach `tag:server:22`). The runner repo reuses the tailnet's existing
`tag:server` and `tag:gh-deploy` tags; no new tags are introduced.

### Verifying the deploy

```sh
# After pushing to main, watch the workflow run, then on the VM:
journalctl -u oh-my-github-runner.service -n 50 -f
git -C /opt/oh-my-github-runner/current log -1 --format='%h %s'
```

If the deploy script no-ops because the VM is already at the requested
commit (e.g., a manual `git pull` ran first), the workflow logs
`Already at <sha>; nothing to deploy.` and exits 0. The service is
left untouched.

## Operational tips

- Logs: `journalctl -u oh-my-github-runner.service -f`
- Tunnel logs: `journalctl -u cloudflared.service -f`
- Manual rate-limit reset: `sudo rm /opt/oh-my-github-runner/current/var/queue/state.json`
- Recovery from crash: `recoverRunningTasks` runs at startup and marks
  in-flight tasks as failed; orphaned workspaces are not cleaned automatically
  in v1
- Manual deploy: `ssh deploy@<tailnet-host> 'sudo /opt/oh-my-github-runner/current/ops/scripts/deploy.sh'`
