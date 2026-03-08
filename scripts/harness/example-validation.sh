#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

# shellcheck disable=SC1091
source "$repo_root/scripts/lib/worktree.sh"

metadata_file="$(discode_app_metadata_file)"
if [[ ! -f "$metadata_file" ]]; then
  echo "No running harness app metadata found. Start the app with ./scripts/harness/boot.sh first." >&2
  exit 1
fi

export HARNESS_METADATA_JSON="$(cat "$metadata_file")"

app_url="$(node -e 'const data=JSON.parse(process.env.HARNESS_METADATA_JSON); process.stdout.write(data.app_url)')"
healthcheck_url="$(node -e 'const data=JSON.parse(process.env.HARNESS_METADATA_JSON); process.stdout.write(data.healthcheck_url)')"
worktree_id="$(node -e 'const data=JSON.parse(process.env.HARNESS_METADATA_JSON); process.stdout.write(data.worktree_id)')"

cat <<EOF
Worktree app is ready.

1. Healthcheck
   curl -fsS "$healthcheck_url"

2. Agent-browser validation prompt
   Open $app_url
   Wait until the page heading "Your ultimate IDE is a messenger." is visible
   Capture a DOM snapshot
   Capture a screenshot of the hero and install-command card
   Click the "npm" install tab and verify the command becomes "npm install -g @siisee11/discode"
   Change the language selector to Korean and verify the hero text updates

3. Verification target
   Worktree: $worktree_id
EOF
