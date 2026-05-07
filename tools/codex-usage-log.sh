#!/usr/bin/env bash
# Detects whether the codex CLI was invoked during a workflow run by diffing
# ~/.codex against a marker file. Read-only on the run itself: zero impact on
# performance, tokens, or the call path between claude and the codex plugin.
#
# Usage:
#   codex-usage-log.sh mark      # call once before the action runs
#   codex-usage-log.sh report    # call once after — prints diff
#
# Env overrides:
#   CODEX_USAGE_MARKER  marker path  (default: /tmp/codex-usage-marker)
#   CODEX_DIR           codex home   (default: $HOME/.codex)

set -euo pipefail

MARKER=${CODEX_USAGE_MARKER:-/tmp/codex-usage-marker}
CODEX_DIR=${CODEX_DIR:-$HOME/.codex}

cmd=${1:-report}

case "$cmd" in
  mark)
    rm -f "$MARKER"
    touch "$MARKER"
    echo "marker: $MARKER ($(date -Iseconds))"
    ;;
  report)
    if [ ! -f "$MARKER" ]; then
      echo "no marker at $MARKER — call 'mark' first"
      exit 0
    fi
    if [ ! -d "$CODEX_DIR" ]; then
      echo "codex usage: $CODEX_DIR absent — codex never logged in or never invoked"
      exit 0
    fi
    new_files=$(find "$CODEX_DIR" -newer "$MARKER" -type f 2>/dev/null || true)
    count=$(printf '%s\n' "$new_files" | grep -c . || true)
    echo "codex usage: $count file(s) modified under $CODEX_DIR since marker"
    if [ "$count" -gt 0 ]; then
      printf '%s\n' "$new_files"
    fi
    ;;
  *)
    echo "usage: $0 {mark|report}" >&2
    exit 1
    ;;
esac
