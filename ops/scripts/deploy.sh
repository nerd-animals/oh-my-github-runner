#!/bin/bash
# Updates the runner to origin/main and restarts the service if there is a diff.
# Designed to be invoked by the SSH user (the same user that owns the repo,
# typically ubuntu) from GitHub Actions over Tailscale SSH. Sudoers must
# allow that user:
#   <ssh_user> ALL=(root) NOPASSWD: /bin/systemctl restart oh-my-github-runner.service
set -euo pipefail

REPO_ROOT=${REPO_ROOT:-/home/ubuntu/runner-deploy}
SERVICE=${SERVICE:-oh-my-github-runner.service}
TASKS_JSON="$REPO_ROOT/var/queue/tasks.json"
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
while [ -f "$TASKS_JSON" ]; do
  # jq 1.6 returns exit 0 with empty stdout on a zero-byte file (e.g. mid
  # atomic rewrite), so `|| echo "?"` alone isn't enough — normalize any
  # non-integer result to "?" so transient corruption falls into the retry
  # branch instead of a silent break.
  running=$(jq -r '[.[] | select(.status=="running")] | length' "$TASKS_JSON" 2>/dev/null || true)
  case "$running" in
    ''|*[!0-9]*) running="?";;
  esac
  if [ "$running" = "0" ]; then
    break
  fi
  if [ "$running" = "?" ]; then
    echo "tasks.json read failed transiently; retrying in ${POLL_SEC}s"
  else
    echo "Waiting: $running task(s) still running"
  fi
  sleep "$POLL_SEC"
done

git reset --hard "$remote"
# Keep dev deps because tsc (typescript) lives in devDependencies and is
# required for `npm run compile`.
npm ci --silent
npm run compile --silent

sudo /bin/systemctl restart "$SERVICE"
echo "Restarted $SERVICE; now at $remote."
