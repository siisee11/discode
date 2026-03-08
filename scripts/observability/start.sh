#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

# shellcheck disable=SC1091
source "$repo_root/scripts/lib/worktree.sh"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required for the local observability stack." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but the daemon is not reachable." >&2
  exit 1
fi

discode_ensure_runtime_dirs

port_base="$(discode_resolve_port_base 0 1 2 3 4 5 6 7)"
discode_write_ports_file "$port_base"
discode_load_ports_file

worktree_id="$(discode_worktree_id)"
obs_dir="$(discode_observability_dir)"
metadata_file="$obs_dir/metadata.json"
config_template="$repo_root/scripts/observability/vector.toml"
generated_config="$obs_dir/vector.generated.toml"

network_name="discode-harness-${worktree_id}"
vlogs_container="discode-vlogs-${worktree_id}"
vmetrics_container="discode-vmetrics-${worktree_id}"
vtraces_container="discode-vtraces-${worktree_id}"
vector_container="discode-vector-${worktree_id}"

export DISCODE_VLOGS_IMAGE="${DISCODE_VLOGS_IMAGE:-victoriametrics/victoria-logs:latest}"
export DISCODE_VMETRICS_IMAGE="${DISCODE_VMETRICS_IMAGE:-victoriametrics/victoria-metrics:latest}"
export DISCODE_VTRACES_IMAGE="${DISCODE_VTRACES_IMAGE:-victoriametrics/victoria-traces:latest}"
export DISCODE_VECTOR_IMAGE="${DISCODE_VECTOR_IMAGE:-timberio/vector:latest-alpine}"

mkdir -p "$obs_dir/vector" "$obs_dir/victoria-logs" "$obs_dir/victoria-metrics" "$obs_dir/victoria-traces"

sed \
  -e "s/__VECTOR_API_PORT__/${DISCODE_VECTOR_API_PORT}/g" \
  -e "s/__VECTOR_LOG_PORT__/${DISCODE_VECTOR_LOG_PORT}/g" \
  -e "s/__VECTOR_OTLP_GRPC_PORT__/${DISCODE_VECTOR_OTLP_GRPC_PORT}/g" \
  -e "s/__VECTOR_OTLP_HTTP_PORT__/${DISCODE_VECTOR_OTLP_HTTP_PORT}/g" \
  -e "s/__VLOGS_CONTAINER__/${vlogs_container}/g" \
  -e "s/__VMETRICS_CONTAINER__/${vmetrics_container}/g" \
  -e "s/__VTRACES_CONTAINER__/${vtraces_container}/g" \
  "$config_template" >"$generated_config"

docker network inspect "$network_name" >/dev/null 2>&1 || docker network create "$network_name" >/dev/null

for container in "$vector_container" "$vlogs_container" "$vmetrics_container" "$vtraces_container"; do
  docker rm -f "$container" >/dev/null 2>&1 || true
done

docker run -d --rm \
  --name "$vlogs_container" \
  --network "$network_name" \
  -p "${DISCODE_VLOGS_PORT}:9428" \
  -v "$obs_dir/victoria-logs:/victoria-logs-data" \
  "$DISCODE_VLOGS_IMAGE" \
  -storageDataPath=/victoria-logs-data >/dev/null

docker run -d --rm \
  --name "$vmetrics_container" \
  --network "$network_name" \
  -p "${DISCODE_VMETRICS_PORT}:8428" \
  -v "$obs_dir/victoria-metrics:/victoria-metrics-data" \
  "$DISCODE_VMETRICS_IMAGE" \
  -storageDataPath=/victoria-metrics-data >/dev/null

docker run -d --rm \
  --name "$vtraces_container" \
  --network "$network_name" \
  -p "${DISCODE_VTRACES_PORT}:10428" \
  -v "$obs_dir/victoria-traces:/victoria-traces-data" \
  "$DISCODE_VTRACES_IMAGE" \
  -storageDataPath=/victoria-traces-data >/dev/null

docker run -d --rm \
  --name "$vector_container" \
  --network "$network_name" \
  -p "${DISCODE_VECTOR_LOG_PORT}:${DISCODE_VECTOR_LOG_PORT}" \
  -p "${DISCODE_VECTOR_OTLP_GRPC_PORT}:${DISCODE_VECTOR_OTLP_GRPC_PORT}" \
  -p "${DISCODE_VECTOR_OTLP_HTTP_PORT}:${DISCODE_VECTOR_OTLP_HTTP_PORT}" \
  -p "${DISCODE_VECTOR_API_PORT}:${DISCODE_VECTOR_API_PORT}" \
  -v "$generated_config:/etc/vector/vector.toml:ro" \
  -v "$obs_dir/vector:/var/lib/vector" \
  "$DISCODE_VECTOR_IMAGE" \
  --config /etc/vector/vector.toml >/dev/null

discode_wait_for_http_ok "http://127.0.0.1:${DISCODE_VLOGS_PORT}/metrics" 30
discode_wait_for_http_ok "http://127.0.0.1:${DISCODE_VMETRICS_PORT}/metrics" 30
discode_wait_for_http_ok "http://127.0.0.1:${DISCODE_VTRACES_PORT}/metrics" 30
discode_wait_for_http_ok "http://127.0.0.1:${DISCODE_VECTOR_API_PORT}/health" 30

cat >"$metadata_file" <<EOF
{
  "worktree_id": "$worktree_id",
  "network": "$network_name",
  "vector_log_port": $DISCODE_VECTOR_LOG_PORT,
  "vector_otlp_grpc_port": $DISCODE_VECTOR_OTLP_GRPC_PORT,
  "vector_otlp_http_port": $DISCODE_VECTOR_OTLP_HTTP_PORT,
  "vector_api_port": $DISCODE_VECTOR_API_PORT,
  "vlogs_port": $DISCODE_VLOGS_PORT,
  "vmetrics_port": $DISCODE_VMETRICS_PORT,
  "vtraces_port": $DISCODE_VTRACES_PORT,
  "log_endpoint": "http://127.0.0.1:${DISCODE_VECTOR_LOG_PORT}/logs",
  "otlp_endpoint": "http://127.0.0.1:${DISCODE_VECTOR_OTLP_HTTP_PORT}",
  "vector_health": "http://127.0.0.1:${DISCODE_VECTOR_API_PORT}/health",
  "vlogs_query": "http://127.0.0.1:${DISCODE_VLOGS_PORT}/select/logsql/query",
  "vmetrics_query": "http://127.0.0.1:${DISCODE_VMETRICS_PORT}/api/v1/query",
  "vtraces_query": "http://127.0.0.1:${DISCODE_VTRACES_PORT}/select/logsql/query"
}
EOF

cat "$metadata_file"
