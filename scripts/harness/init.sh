#!/usr/bin/env bash

set -euo pipefail

log() {
  printf '[harness-init] %s\n' "$*" >&2
}

usage() {
  cat >&2 <<'EOF'
Usage: scripts/harness/init.sh [--base-branch <branch>] [--work-branch <name>]
EOF
}

slugify() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g'
}

json_print() {
  node -e '
    const [worktreeId, worktreePath, workBranch, baseBranch, runtimeRoot] = process.argv.slice(1);
    console.log(JSON.stringify({
      worktree_id: worktreeId,
      worktree_path: worktreePath,
      work_branch: workBranch,
      base_branch: baseBranch,
      deps_installed: true,
      build_verified: true,
      runtime_root: runtimeRoot,
    }, null, 2));
  ' "$@"
}

resolve_branch_worktree() {
  local target_branch="$1"
  local current_path=""
  local current_branch=""

  while IFS= read -r line; do
    if [[ "$line" == worktree\ * ]]; then
      current_path="${line#worktree }"
      current_branch=""
      continue
    fi

    if [[ "$line" == branch\ refs/heads/* ]]; then
      current_branch="${line#branch refs/heads/}"
      if [[ "$current_branch" == "$target_branch" ]]; then
        printf '%s\n' "$current_path"
        return 0
      fi
    fi
  done < <(git -C "$repo_root" worktree list --porcelain)

  return 1
}

base_branch="main"
work_branch=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-branch)
      [[ $# -ge 2 ]] || {
        usage
        exit 1
      }
      base_branch="$2"
      shift 2
      ;;
    --work-branch)
      [[ $# -ge 2 ]] || {
        usage
        exit 1
      }
      work_branch="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
repo_name="$(basename "$repo_root")"
repo_parent="$(dirname "$repo_root")"
repo_common_dir="$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)"
worktrees_root_default="$repo_parent/${repo_name}-worktrees"
worktrees_root="${DISCODE_WORKTREES_ROOT:-$worktrees_root_default}"

current_top=""
current_common=""
current_git_dir=""
inside_repo=0
if current_top="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null)"; then
  current_common="$(git -C "$PWD" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  current_git_dir="$(git -C "$PWD" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)"
  if [[ -n "$current_common" && "$current_common" == "$repo_common_dir" ]]; then
    inside_repo=1
  fi
fi

if [[ -z "$work_branch" ]]; then
  if [[ $inside_repo -eq 1 ]]; then
    work_branch="$(git -C "$current_top" rev-parse --abbrev-ref HEAD)"
  else
    work_branch="harness/$(date +%Y%m%d-%H%M%S)"
  fi
fi

worktree_path=""
if [[ $inside_repo -eq 1 && "$current_git_dir" != "$current_common" ]]; then
  worktree_path="$current_top"
  log "Reusing linked worktree: $worktree_path"
else
  existing_worktree="$(resolve_branch_worktree "$work_branch" || true)"
  if [[ -n "$existing_worktree" ]]; then
    worktree_path="$existing_worktree"
    log "Reusing existing worktree for branch $work_branch: $worktree_path"
  else
    branch_slug="$(slugify "$work_branch")"
    if [[ -z "$branch_slug" ]]; then
      branch_slug="worktree"
    fi
    mkdir -p "$worktrees_root"
    worktree_path="$worktrees_root/$branch_slug"
    if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$work_branch"; then
      log "Creating worktree at $worktree_path from existing branch $work_branch"
      git -C "$repo_root" worktree add "$worktree_path" "$work_branch" >&2
    else
      log "Creating worktree at $worktree_path from $base_branch as $work_branch"
      git -C "$repo_root" worktree add -b "$work_branch" "$worktree_path" "$base_branch" >&2
    fi
  fi
fi

worktree_path="$(cd "$worktree_path" && pwd)"

if [[ -n "$(git -C "$worktree_path" status --porcelain)" ]]; then
  stash_label="harness-init-$(date +%s)"
  log "Stashing local changes in $worktree_path as $stash_label"
  git -C "$worktree_path" stash push --include-untracked --message "$stash_label" >&2 || true
fi

current_branch="$(git -C "$worktree_path" rev-parse --abbrev-ref HEAD)"
if [[ "$current_branch" != "$work_branch" ]]; then
  log "Switching $worktree_path to branch $work_branch"
  if git -C "$worktree_path" show-ref --verify --quiet "refs/heads/$work_branch"; then
    git -C "$worktree_path" switch "$work_branch" >&2
  else
    git -C "$worktree_path" switch -c "$work_branch" "$base_branch" >&2
  fi
fi

repo_slug="$(slugify "$(basename "$worktree_path")")"
if [[ -z "$repo_slug" ]]; then
  repo_slug="worktree"
fi
worktree_hash="$(printf '%s' "$worktree_path" | cksum | awk '{print $1}')"
worktree_id="${repo_slug}-${worktree_hash}"
runtime_root="$worktree_path/.worktree/$worktree_id"
logs_dir="$runtime_root/logs"
tmp_dir="$runtime_root/tmp"
browser_profile_dir="$runtime_root/browser-profile"
vite_cache_dir="$runtime_root/vite-cache"
observability_dir="$runtime_root/observability"

mkdir -p "$logs_dir" "$tmp_dir" "$browser_profile_dir" "$vite_cache_dir" "$observability_dir"

if [[ -f "$worktree_path/.env.example" && ! -f "$worktree_path/.env" ]]; then
  log "Copying .env.example to .env"
  cp "$worktree_path/.env.example" "$worktree_path/.env"
fi

if [[ -f "$worktree_path/package.json" && ! -e "$worktree_path/node_modules" && "$worktree_path" != "$repo_root" && -d "$repo_root/node_modules" ]]; then
  log "Linking node_modules from the primary checkout"
  ln -s "$repo_root/node_modules" "$worktree_path/node_modules"
fi

cat > "$runtime_root/harness.env" <<EOF
DISCODE_WORKTREE_ID=$worktree_id
DISCODE_RUNTIME_ROOT=$runtime_root
DISCODE_LOGS_DIR=$logs_dir
DISCODE_TMP_DIR=$tmp_dir
DISCODE_BROWSER_PROFILE_DIR=$browser_profile_dir
DISCODE_VITE_CACHE_DIR=$vite_cache_dir
EOF

if [[ -f "$worktree_path/package.json" ]]; then
  if [[ -d "$worktree_path/node_modules" ]]; then
    log "Dependencies already present; skipping npm install"
  else
    log "Installing npm dependencies"
    (cd "$worktree_path" && npm install >&2)
  fi
elif [[ -f "$worktree_path/Cargo.toml" ]]; then
  log "Building Cargo dependencies"
  (cd "$worktree_path" && cargo build >&2)
fi

if [[ -f "$worktree_path/Makefile.harness" ]]; then
  log "Running make smoke"
  (cd "$worktree_path" && make smoke >&2)
elif [[ -f "$worktree_path/package.json" ]]; then
  log "Running npm run build"
  (cd "$worktree_path" && npm run build >&2)
elif [[ -f "$worktree_path/Cargo.toml" ]]; then
  log "Running cargo build"
  (cd "$worktree_path" && cargo build >&2)
fi

json_print "$worktree_id" "$worktree_path" "$work_branch" "$base_branch" ".worktree/$worktree_id/"
