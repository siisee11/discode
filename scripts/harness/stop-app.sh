#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

# shellcheck disable=SC1091
source "$repo_root/scripts/lib/worktree.sh"

pid_file="$(discode_app_pid_file)"
metadata_file="$(discode_app_metadata_file)"

if [[ -f "$pid_file" ]]; then
  pid="$(cat "$pid_file")"
  if discode_pid_is_running "$pid"; then
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
fi

rm -f "$metadata_file"

if [[ "${DISCODE_OBSERVABILITY:-0}" == "1" ]]; then
  "$repo_root/scripts/observability/stop.sh" >/dev/null
fi
