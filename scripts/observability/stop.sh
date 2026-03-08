#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

# shellcheck disable=SC1091
source "$repo_root/scripts/lib/worktree.sh"

worktree_id="$(discode_worktree_id)"
obs_dir="$(discode_observability_dir)"
network_name="discode-harness-${worktree_id}"

for container in \
  "discode-vector-${worktree_id}" \
  "discode-vlogs-${worktree_id}" \
  "discode-vmetrics-${worktree_id}" \
  "discode-vtraces-${worktree_id}"; do
  docker rm -f "$container" >/dev/null 2>&1 || true
done

docker network rm "$network_name" >/dev/null 2>&1 || true
rm -f "$obs_dir/metadata.json" "$obs_dir/vector.generated.toml"

if [[ "${DISCODE_OBSERVABILITY_CLEAN:-0}" == "1" ]]; then
  rm -rf "$obs_dir/vector" "$obs_dir/victoria-logs" "$obs_dir/victoria-metrics" "$obs_dir/victoria-traces"
fi
