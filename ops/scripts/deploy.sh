#!/bin/bash
# Updates the runner to origin/main and restarts the service if there is a diff.
# Designed to be invoked by the SSH user (the same user that owns the repo,
# typically ubuntu) from GitHub Actions over Tailscale SSH. Sudoers must
# allow that user:
#   <ssh_user> ALL=(root) NOPASSWD: /bin/systemctl restart oh-my-github-runner.service
set -euo pipefail

REPO_ROOT=${REPO_ROOT:-/home/ubuntu/runner-deploy}
SERVICE=${SERVICE:-oh-my-github-runner.service}
RUNNING_DIR="$REPO_ROOT/var/queue/running"
POLL_SEC=${RUNNER_DEPLOY_POLL_SEC:-5}
MAX_WAIT_SEC=${RUNNER_DEPLOY_MAX_WAIT_SEC:-120}

cd "$REPO_ROOT"

git fetch --quiet origin main

current=$(git rev-parse HEAD)
remote=$(git rev-parse origin/main)

if [ "$current" = "$remote" ]; then
  echo "Already at $current; nothing to deploy."
  exit 0
fi

echo "Updating $current -> $remote"

# Wait briefly for running tasks to drain before reset/build/restart. If a
# task is still running after MAX_WAIT_SEC, abandon this deploy with non-zero
# exit and leave the service on the old SHA: the next push (or manual
# workflow_dispatch) re-runs against the latest origin/main. This avoids the
# old failure mode where an open-ended wait got killed by the GitHub Actions
# job timeout (15m) mid-restart.
start_ts=$(date +%s)
while true; do
  if [ -d "$RUNNING_DIR" ]; then
    running=$(find "$RUNNING_DIR" -mindepth 1 -maxdepth 1 -type f -name '*.json' 2>/dev/null | wc -l)
  else
    running=0
  fi
  if [ "$running" -eq 0 ]; then
    break
  fi
  elapsed=$(( $(date +%s) - start_ts ))
  if [ "$elapsed" -ge "$MAX_WAIT_SEC" ]; then
    echo "Drain timeout after ${elapsed}s; ${running} task(s) still running; leaving service unchanged." >&2
    exit 1
  fi
  echo "Waiting: $running task(s) still running (${elapsed}s/${MAX_WAIT_SEC}s)"
  sleep "$POLL_SEC"
done

git reset --hard "$remote"
# Keep dev deps because tsc (typescript) lives in devDependencies and is
# required for `npm run compile`.
npm ci --silent
npm run compile --silent
# tsc can exit 0 without emitting the entrypoint (stale .tsbuildinfo,
# project references gone wrong, type-only sources). Block restart so the
# service does not loop on a missing main module.
[ -f dist/src/index.js ] || {
  echo "compile produced no entrypoint: dist/src/index.js" >&2
  exit 1
}

sudo /bin/systemctl restart "$SERVICE"

# `systemctl restart` returns as soon as systemd accepts the request, so a
# daemon that throws on startup leaves the unit in a Restart=always
# crashloop while this script otherwise reports success. Poll `is-active`
# until the state is stably `active`, or fail the deploy with a journal
# tail so the operator can see why.
#
# A crashlooping unit spends most of its time in `activating` (RestartSec
# backoff, default 5s in oh-my-github-runner.service). Requiring multiple
# consecutive `active` samples — not just a single hit — rules out the
# "active for a moment between crashes" blip.
#
# `systemctl is-active` and `journalctl -u <unit>` are read-only and the
# ubuntu user can run them without sudo (journal access via group `adm`),
# so this check does not require expanding the sudoers grant.
VERIFY_INTERVAL_SEC=${RUNNER_DEPLOY_VERIFY_INTERVAL_SEC:-1}
VERIFY_TIMEOUT_COUNT=${RUNNER_DEPLOY_VERIFY_TIMEOUT_COUNT:-15}
VERIFY_STABLE_COUNT=${RUNNER_DEPLOY_VERIFY_STABLE_COUNT:-3}
stable=0
state="unknown"
attempt=0
while [ "$attempt" -lt "$VERIFY_TIMEOUT_COUNT" ]; do
  sleep "$VERIFY_INTERVAL_SEC"
  attempt=$(( attempt + 1 ))
  state=$(systemctl is-active "$SERVICE" 2>/dev/null || true)
  if [ "$state" = "active" ]; then
    stable=$(( stable + 1 ))
    [ "$stable" -ge "$VERIFY_STABLE_COUNT" ] && break
  else
    stable=0
  fi
done

if [ "$stable" -lt "$VERIFY_STABLE_COUNT" ]; then
  echo "Service did not stabilize after restart (state=$state, stable=${stable}/${VERIFY_STABLE_COUNT}, attempts=${attempt}/${VERIFY_TIMEOUT_COUNT})" >&2
  journalctl -u "$SERVICE" -n 80 --no-pager 2>&1 || true
  exit 1
fi

echo "Restarted $SERVICE; now at $remote."
