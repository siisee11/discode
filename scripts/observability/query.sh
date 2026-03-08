#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

# shellcheck disable=SC1091
source "$repo_root/scripts/lib/worktree.sh"

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <logs|metrics|traces> <query>" >&2
  exit 1
fi

kind="$1"
shift
query="$*"

discode_load_ports_file

case "$kind" in
  logs)
    exec curl -fsS -X POST "http://127.0.0.1:${DISCODE_VLOGS_PORT}/select/logsql/query" \
      --data-urlencode "query=${query}"
    ;;
  metrics)
    exec curl -fsS --get "http://127.0.0.1:${DISCODE_VMETRICS_PORT}/api/v1/query" \
      --data-urlencode "query=${query}"
    ;;
  traces)
    exec curl -fsS -X POST "http://127.0.0.1:${DISCODE_VTRACES_PORT}/select/logsql/query" \
      --data-urlencode "query=${query}"
    ;;
  *)
    echo "Unknown signal type: $kind" >&2
    exit 1
    ;;
esac
