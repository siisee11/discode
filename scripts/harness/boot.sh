#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

# shellcheck disable=SC1091
source "$repo_root/scripts/lib/worktree.sh"

discode_ensure_runtime_dirs

port_base="$(discode_resolve_port_base 0 1 2 3 4 5 6 7)"
discode_write_ports_file "$port_base"
discode_load_ports_file

worktree_id="$(discode_worktree_id)"
runtime_root="$(discode_runtime_root)"
metadata_file="$(discode_app_metadata_file)"
pid_file="$(discode_app_pid_file)"
log_file="$(discode_app_log_file)"
app_host="${DISCODE_APP_HOST:-127.0.0.1}"
app_url="http://${app_host}:${DISCODE_APP_PORT}/"
healthcheck_url="${app_url}__harness/health"

if [[ -f "$pid_file" ]]; then
  existing_pid="$(cat "$pid_file")"
  if discode_pid_is_running "$existing_pid" && discode_wait_for_http_body_fragment "$healthcheck_url" '"ok":true' 2; then
    cat "$metadata_file"
    exit 0
  fi
  rm -f "$pid_file"
fi

if [[ "${DISCODE_OBSERVABILITY:-0}" == "1" ]]; then
  "$repo_root/scripts/observability/start.sh" >/dev/null
fi

export DISCODE_WORKTREE_ID="$worktree_id"
export DISCODE_APP_HOST="$app_host"
export DISCODE_APP_PORT
export DISCODE_VITE_CACHE_DIR="$(discode_vite_cache_dir)"
export DISCODE_BOOT_STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
export TMPDIR="$(discode_tmp_dir)"
if [[ "${DISCODE_OBSERVABILITY:-0}" == "1" ]]; then
  export LOG_ENDPOINT="http://127.0.0.1:${DISCODE_VECTOR_LOG_PORT}/logs"
  export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:${DISCODE_VECTOR_OTLP_HTTP_PORT}"
else
  unset LOG_ENDPOINT || true
  unset OTEL_EXPORTER_OTLP_ENDPOINT || true
fi

app_pid="$(
  node -e '
    const { spawn } = require("child_process");
    const fs = require("fs");
    const [scriptPath, logPath] = process.argv.slice(1);
    const logFd = fs.openSync(logPath, "a");
    const child = spawn(process.execPath, [scriptPath], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.unref();
    process.stdout.write(String(child.pid));
  ' "$repo_root/scripts/harness/dev-server.mjs" "$log_file"
)"
echo "$app_pid" >"$pid_file"

if ! discode_wait_for_http_body_fragment "$healthcheck_url" '"ok":true' "${DISCODE_APP_BOOT_TIMEOUT_SECONDS:-30}"; then
  kill "$app_pid" >/dev/null 2>&1 || true
  rm -f "$pid_file"
  echo "Worktree app failed to become ready. Inspect $log_file" >&2
  exit 1
fi

cat >"$metadata_file" <<EOF
{
  "worktree_id": "$worktree_id",
  "app": "discode-site-dev",
  "app_url": "$app_url",
  "healthcheck_url": "$healthcheck_url",
  "port": $DISCODE_APP_PORT,
  "pid": $app_pid,
  "runtime_root": "$runtime_root",
  "log_file": "$log_file",
  "browser_profile_dir": "$(discode_browser_profile_dir)",
  "vite_cache_dir": "$(discode_vite_cache_dir)",
  "tmp_dir": "$(discode_tmp_dir)",
  "observability_enabled": ${DISCODE_OBSERVABILITY:-0},
  "observability": {
    "log_endpoint": null,
    "otlp_http_endpoint": null,
    "vector_api_endpoint": null
  }
}
EOF

if [[ "${DISCODE_OBSERVABILITY:-0}" == "1" ]]; then
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.observability = {
      log_endpoint: process.argv[2],
      otlp_http_endpoint: process.argv[3],
      vector_api_endpoint: process.argv[4],
    };
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  ' "$metadata_file" \
    "http://127.0.0.1:${DISCODE_VECTOR_LOG_PORT}/logs" \
    "http://127.0.0.1:${DISCODE_VECTOR_OTLP_HTTP_PORT}" \
    "http://127.0.0.1:${DISCODE_VECTOR_API_PORT}/health"
fi

cat "$metadata_file"
