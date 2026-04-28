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
IDLE_TIMEOUT_SEC=${RUNNER_DEPLOY_IDLE_TIMEOUT_SEC:-600}
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
# Run this BEFORE git reset so a timeout-skip leaves disk == memory (both at
# old SHA), letting the next deploy push retry naturally.
elapsed=0
while [ -f "$TASKS_JSON" ]; do
  running=$(jq -r '[.[] | select(.status=="running")] | length' "$TASKS_JSON" 2>/dev/null || echo "?")
  if [ "$running" = "0" ]; then
    break
  fi
  if [ "$running" = "?" ]; then
    echo "tasks.json read failed transiently; retrying in ${POLL_SEC}s"
  elif [ "$elapsed" -ge "$IDLE_TIMEOUT_SEC" ]; then
    if [ "${RUNNER_DEPLOY_FORCE_RESTART:-0}" = "1" ]; then
      echo "Timed out waiting for $running running task(s); forcing restart per RUNNER_DEPLOY_FORCE_RESTART=1."
      break
    fi
    echo "Timed out (${IDLE_TIMEOUT_SEC}s) with $running running task(s); skipping deploy. Next push will retry."
    exit 0
  else
    echo "Waiting: $running task(s) still running (elapsed=${elapsed}s, timeout=${IDLE_TIMEOUT_SEC}s)"
  fi
  sleep "$POLL_SEC"
  elapsed=$((elapsed + POLL_SEC))
done

git reset --hard "$remote"
# Keep dev deps because tsc (typescript) lives in devDependencies and is
# required for `npm run compile`.
npm ci --silent
npm run compile --silent

sudo /bin/systemctl restart "$SERVICE"
echo "Restarted $SERVICE; now at $remote."
