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

cd "$REPO_ROOT"

git fetch --quiet origin main

current=$(git rev-parse HEAD)
remote=$(git rev-parse origin/main)

if [ "$current" = "$remote" ]; then
  echo "Already at $current; nothing to deploy."
  exit 0
fi

echo "Updating $current -> $remote"

# Wait for running tasks to drain before reset/build/restart. If we restarted
# while tasks are running, recoverRunningTasks() would mark them as failed.
# Run this BEFORE git reset so disk and memory stay aligned at the old SHA;
# if the workflow gets killed mid-wait, the next push retries naturally.
while true; do
  if [ -d "$RUNNING_DIR" ]; then
    running=$(find "$RUNNING_DIR" -mindepth 1 -maxdepth 1 -type f -name '*.json' 2>/dev/null | wc -l)
  else
    running=0
  fi
  if [ "$running" -eq 0 ]; then
    break
  fi
  echo "Waiting: $running task(s) still running"
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
