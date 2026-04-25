#!/usr/bin/env bash
# Verify GitHub App authentication end-to-end.
# Runs 4 checks: App self-check, installation lookup, token mint, repo fetch.
#
# Usage:
#   tools/verify-github-app.sh [path-to-env-file]
#   default env file: /etc/oh-my-github-runner/runner.env

set -euo pipefail

ENV_FILE="${1:-/etc/oh-my-github-runner/runner.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: env file not found: $ENV_FILE" >&2
  exit 1
fi

read_env() {
  grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
}

APP_ID=$(read_env GITHUB_APP_ID)
KEY_PATH=$(read_env GITHUB_APP_PRIVATE_KEY_PATH)

if [ -z "$APP_ID" ] || [ -z "$KEY_PATH" ]; then
  echo "ERROR: GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY_PATH missing in $ENV_FILE" >&2
  exit 1
fi

if [ ! -f "$KEY_PATH" ]; then
  echo "ERROR: private key not found: $KEY_PATH" >&2
  exit 1
fi

echo "App ID: $APP_ID"
echo "Key:    $KEY_PATH"
echo

read -p "Test repo (owner/repo): " REPO
if [[ ! "$REPO" =~ ^[^/]+/[^/]+$ ]]; then
  echo "ERROR: must be owner/repo format" >&2
  exit 1
fi

NOW=$(date +%s)
b64url() { base64 -w0 | tr -d '=' | tr '+/' '-_'; }
HEADER=$(printf '%s' '{"alg":"RS256","typ":"JWT"}' | b64url)
PAYLOAD=$(printf '%s' "{\"iat\":$((NOW - 60)),\"exp\":$((NOW + 540)),\"iss\":\"$APP_ID\"}" | b64url)
SIG=$(printf '%s' "${HEADER}.${PAYLOAD}" | openssl dgst -sha256 -sign "$KEY_PATH" -binary | b64url)
JWT="${HEADER}.${PAYLOAD}.${SIG}"

api() {
  local METHOD="$1" AUTH="$2" URL="$3"
  curl -sS -X "$METHOD" \
    -H "Authorization: Bearer $AUTH" \
    -H "Accept: application/vnd.github+json" \
    -H "User-Agent: verify-github-app" \
    -w '\n%{http_code}' \
    "$URL"
}

extract_string() { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
extract_int() { grep -o "\"$1\":[0-9]*" | head -1 | grep -o '[0-9]*'; }

run_check() {
  local LABEL="$1" EXPECTED="$2" METHOD="$3" AUTH="$4" URL="$5"
  echo "$LABEL"
  local RESP
  RESP=$(api "$METHOD" "$AUTH" "$URL")
  local CODE BODY
  CODE=$(echo "$RESP" | tail -n1)
  BODY=$(echo "$RESP" | sed '$d')
  if [ "$CODE" != "$EXPECTED" ]; then
    echo "  ✗ HTTP $CODE (expected $EXPECTED)"
    echo "$BODY"
    return 1
  fi
  printf '%s' "$BODY"
}

echo "[1/4] App self-check — GET /app"
APP_BODY=$(run_check "" 200 GET "$JWT" https://api.github.com/app) || exit 1
APP_NAME=$(echo "$APP_BODY" | extract_string name)
echo "  ✓ 200 OK — App name: $APP_NAME"
echo

echo "[2/4] Installation lookup — GET /repos/$REPO/installation"
INSTALL_BODY=$(run_check "" 200 GET "$JWT" "https://api.github.com/repos/$REPO/installation") || {
  echo
  echo "Hint: App을 이 repo에 install했는지 확인. repo 이름 오타도 확인."
  exit 1
}
INSTALL_ID=$(echo "$INSTALL_BODY" | extract_int id)
echo "  ✓ 200 OK — Installation ID: $INSTALL_ID"
echo

echo "[3/4] Token mint — POST /app/installations/$INSTALL_ID/access_tokens"
TOKEN_BODY=$(run_check "" 201 POST "$JWT" "https://api.github.com/app/installations/$INSTALL_ID/access_tokens") || exit 1
TOKEN=$(echo "$TOKEN_BODY" | extract_string token)
EXPIRES=$(echo "$TOKEN_BODY" | extract_string expires_at)
echo "  ✓ 201 Created — Expires: $EXPIRES"
echo

echo "[4/4] Repo fetch with token — GET /repos/$REPO"
REPO_BODY=$(run_check "" 200 GET "$TOKEN" "https://api.github.com/repos/$REPO") || exit 1
DEFAULT_BRANCH=$(echo "$REPO_BODY" | extract_string default_branch)
echo "  ✓ 200 OK — default_branch: $DEFAULT_BRANCH"
echo

echo "================================="
echo "  ALL 4 CHECKS PASSED ✓"
echo "================================="
echo "App ID:       $APP_ID"
echo "App name:     $APP_NAME"
echo "Installation: $INSTALL_ID"
echo "Repo:         $REPO (default: $DEFAULT_BRANCH)"
