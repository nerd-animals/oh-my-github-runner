#!/bin/bash
# Updates the runner to origin/main and restarts the service if there is a diff.
# Designed to be invoked by the SSH user (the same user that owns the repo,
# typically ubuntu) from GitHub Actions over Tailscale SSH. Sudoers must
# allow that user:
#   <ssh_user> ALL=(root) NOPASSWD: /bin/systemctl restart oh-my-github-runner.service
set -euo pipefail

REPO_ROOT=${REPO_ROOT:-/home/ubuntu/runner-deploy}
SERVICE=${SERVICE:-oh-my-github-runner.service}
LEGACY_TASKS_JSON="$REPO_ROOT/var/queue/tasks.json"
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
#
# Two queue layouts coexist for one deploy cycle: the legacy single-file
# `tasks.json` (still in use by the running daemon when this PR first lands)
# and the new task-per-file `running/<id>.json` directory. Sum both — once
# the new daemon takes over and migrates `tasks.json` to `tasks.json.migrated`
# the legacy count is naturally always 0.
while true; do
  # Legacy: count `status=="running"` records inside tasks.json.
  # jq 1.6 returns exit 0 with empty stdout on a zero-byte file, so normalize
  # any non-integer result to "?" — transient corruption hits the retry log
  # instead of a silent break.
  if [ -f "$LEGACY_TASKS_JSON" ]; then
    legacy=$(jq -r '[.[] | select(.status=="running")] | length' "$LEGACY_TASKS_JSON" 2>/dev/null || true)
    case "$legacy" in
      ''|*[!0-9]*) legacy="?";;
    esac
  else
    legacy="0"
  fi

  # New layout: every file in running/ is one running task.
  if [ -d "$RUNNING_DIR" ]; then
    new_count=$(find "$RUNNING_DIR" -mindepth 1 -maxdepth 1 -type f -name '*.json' 2>/dev/null | wc -l)
  else
    new_count=0
  fi

  if [ "$legacy" = "?" ]; then
    echo "tasks.json read failed transiently; retrying in ${POLL_SEC}s"
  elif [ "$legacy" = "0" ] && [ "$new_count" = "0" ]; then
    break
  else
    echo "Waiting: legacy=${legacy} new=${new_count} task(s) still running"
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
