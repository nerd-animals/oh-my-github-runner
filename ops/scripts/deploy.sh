#!/bin/bash
# Updates the runner to origin/main and restarts the service if there is a diff.
# Designed to be invoked by the SSH user (ubuntu by default) from GitHub Actions
# over Tailscale SSH. Sudoers must allow that user:
#   <ssh_user> ALL=(runner) NOPASSWD: /usr/bin/git, /usr/bin/npm
#   <ssh_user> ALL=(root)   NOPASSWD: /bin/systemctl restart oh-my-github-runner.service
set -euo pipefail

REPO_ROOT=${REPO_ROOT:-/opt/oh-my-github-runner/current}
RUNNER_USER=${RUNNER_USER:-runner}
SERVICE=${SERVICE:-oh-my-github-runner.service}

cd "$REPO_ROOT"

sudo -u "$RUNNER_USER" git fetch --quiet origin main

current=$(sudo -u "$RUNNER_USER" git rev-parse HEAD)
remote=$(sudo -u "$RUNNER_USER" git rev-parse origin/main)

if [ "$current" = "$remote" ]; then
  echo "Already at $current; nothing to deploy."
  exit 0
fi

echo "Updating $current -> $remote"

sudo -u "$RUNNER_USER" git reset --hard "$remote"
sudo -u "$RUNNER_USER" npm ci --omit=dev --silent
sudo -u "$RUNNER_USER" npm run compile --silent

sudo /bin/systemctl restart "$SERVICE"
echo "Restarted $SERVICE; now at $remote."
