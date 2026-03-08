#!/usr/bin/env bash

# Shared helpers for worktree-scoped harness scripts.

discode_repo_root() {
  git rev-parse --show-toplevel 2>/dev/null || pwd
}

discode_slugify() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | tr -cs 'a-z0-9' '-' \
    | sed 's/^-//; s/-$//'
}

discode_hash_string() {
  printf '%s' "$1" | cksum | awk '{print $1}'
}

discode_worktree_root() {
  discode_repo_root
}

discode_worktree_id() {
  if [[ -n "${DISCODE_WORKTREE_ID:-}" ]]; then
    printf '%s\n' "$DISCODE_WORKTREE_ID"
    return
  fi

  local root slug hash
  root="$(discode_worktree_root)"
  slug="$(discode_slugify "$(basename "$root")")"
  hash="$(discode_hash_string "$root")"
  printf '%s-%s\n' "${slug:-worktree}" "$hash"
}

discode_runtime_root() {
  printf '%s/.worktree/%s\n' "$(discode_repo_root)" "$(discode_worktree_id)"
}

discode_logs_dir() {
  printf '%s/logs\n' "$(discode_runtime_root)"
}

discode_tmp_dir() {
  printf '%s/tmp\n' "$(discode_runtime_root)"
}

discode_browser_profile_dir() {
  printf '%s/browser-profile\n' "$(discode_runtime_root)"
}

discode_vite_cache_dir() {
  printf '%s/vite-cache\n' "$(discode_runtime_root)"
}

discode_observability_dir() {
  printf '%s/observability\n' "$(discode_runtime_root)"
}

discode_ports_file() {
  printf '%s/ports.env\n' "$(discode_runtime_root)"
}

discode_app_pid_file() {
  printf '%s/app.pid\n' "$(discode_runtime_root)"
}

discode_app_log_file() {
  printf '%s/app.log\n' "$(discode_logs_dir)"
}

discode_app_metadata_file() {
  printf '%s/app.json\n' "$(discode_runtime_root)"
}

discode_port_stride() {
  printf '20\n'
}

discode_port_seed() {
  discode_hash_string "$(discode_worktree_id)"
}

discode_candidate_port_base() {
  local attempt="${1:-0}"
  local seed stride
  seed="$(discode_port_seed)"
  stride="$(discode_port_stride)"
  printf '%s\n' "$((42000 + (((seed % 400) + attempt) * stride)))"
}

discode_port_in_use() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

discode_load_ports_file() {
  local file
  file="$(discode_ports_file)"
  if [[ -f "$file" ]]; then
    # shellcheck disable=SC1090
    source "$file"
  fi
}

discode_write_ports_file() {
  local base="$1"
  local file
  file="$(discode_ports_file)"

  mkdir -p "$(dirname "$file")"
  cat >"$file" <<EOF
DISCODE_PORT_BASE=$base
DISCODE_APP_PORT=$((base + 0))
DISCODE_VECTOR_LOG_PORT=$((base + 1))
DISCODE_VECTOR_OTLP_GRPC_PORT=$((base + 2))
DISCODE_VECTOR_OTLP_HTTP_PORT=$((base + 3))
DISCODE_VLOGS_PORT=$((base + 4))
DISCODE_VMETRICS_PORT=$((base + 5))
DISCODE_VTRACES_PORT=$((base + 6))
DISCODE_VECTOR_API_PORT=$((base + 7))
EOF
}

discode_resolve_port_base() {
  local required_offsets=("$@")
  local base attempt occupied offset

  if [[ -n "${DISCODE_PORT_BASE:-}" ]]; then
    printf '%s\n' "$DISCODE_PORT_BASE"
    return
  fi

  discode_load_ports_file
  if [[ -n "${DISCODE_PORT_BASE:-}" ]]; then
    printf '%s\n' "$DISCODE_PORT_BASE"
    return
  fi

  for attempt in $(seq 0 49); do
    base="$(discode_candidate_port_base "$attempt")"
    occupied=0
    for offset in "${required_offsets[@]}"; do
      if discode_port_in_use "$((base + offset))"; then
        occupied=1
        break
      fi
    done

    if [[ "$occupied" -eq 0 ]]; then
      printf '%s\n' "$base"
      return
    fi
  done

  echo "Unable to allocate a free port block for worktree $(discode_worktree_id)." >&2
  return 1
}

discode_ensure_runtime_dirs() {
  mkdir -p "$(discode_runtime_root)"
  mkdir -p "$(discode_logs_dir)"
  mkdir -p "$(discode_tmp_dir)"
  mkdir -p "$(discode_browser_profile_dir)"
  mkdir -p "$(discode_vite_cache_dir)"
  mkdir -p "$(discode_observability_dir)"
}

discode_pid_is_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

discode_wait_for_http_ok() {
  local url="$1"
  local timeout_seconds="${2:-30}"
  local started_at now
  started_at="$(date +%s)"

  while true; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi

    now="$(date +%s)"
    if (( now - started_at >= timeout_seconds )); then
      return 1
    fi

    sleep 0.2
  done
}

discode_wait_for_http_body_fragment() {
  local url="$1"
  local expected_fragment="$2"
  local timeout_seconds="${3:-30}"
  local started_at now response
  started_at="$(date +%s)"

  while true; do
    response="$(curl -fsS "$url" 2>/dev/null || true)"
    if [[ "$response" == *"$expected_fragment"* ]]; then
      return 0
    fi

    now="$(date +%s)"
    if (( now - started_at >= timeout_seconds )); then
      return 1
    fi

    sleep 0.2
  done
}
