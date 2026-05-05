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
echo "Restarted $SERVICE; now at $remote."
