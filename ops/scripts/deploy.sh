#!/bin/bash
# Updates the runner to origin/main and restarts the service if there is a diff.
# Designed to be invoked by the SSH user (the same user that owns the repo,
# typically ubuntu) from GitHub Actions over Tailscale SSH. Sudoers must
# allow that user:
#   <ssh_user> ALL=(root) NOPASSWD: /bin/systemctl restart oh-my-github-runner.service
set -euo pipefail

REPO_ROOT=${REPO_ROOT:-/home/ubuntu/oh-my-github-runner}
SERVICE=${SERVICE:-oh-my-github-runner.service}

cd "$REPO_ROOT"

git fetch --quiet origin main

current=$(git rev-parse HEAD)
remote=$(git rev-parse origin/main)

if [ "$current" = "$remote" ]; then
  echo "Already at $current; nothing to deploy."
  exit 0
fi

echo "Updating $current -> $remote"

git reset --hard "$remote"
# Keep dev deps because tsc (typescript) lives in devDependencies and is
# required for `npm run compile`.
npm ci --silent
npm run compile --silent

sudo /bin/systemctl restart "$SERVICE"
echo "Restarted $SERVICE; now at $remote."
