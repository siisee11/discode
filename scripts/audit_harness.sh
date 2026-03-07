#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-.}"
failures=0

check_file() {
  local path="$1"
  local label="$2"
  if [[ -f "$repo_root/$path" ]]; then
    echo "[ok] $label"
  else
    echo "[missing] $label"
    failures=$((failures + 1))
  fi
}

check_dir() {
  local path="$1"
  local label="$2"
  if [[ -d "$repo_root/$path" ]]; then
    echo "[ok] $label"
  else
    echo "[missing] $label"
    failures=$((failures + 1))
  fi
}

check_file "AGENTS.md" "AGENTS.md exists"
check_file "ARCHITECTURE.md" "ARCHITECTURE.md exists"
check_file "docs/PLANS.md" "docs/PLANS.md exists"
check_file "docs/OBSERVABILITY.md" "docs/OBSERVABILITY.md exists"
check_file "docs/design-docs/index.md" "docs/design-docs/index.md exists"
check_file "docs/exec-plans/tech-debt-tracker.md" "docs/exec-plans/tech-debt-tracker.md exists"
check_file "docs/product-specs/index.md" "docs/product-specs/index.md exists"
check_file "Makefile.harness" "Makefile.harness exists"
check_file "scripts/audit_harness.sh" "scripts/audit_harness.sh exists"
check_file "scripts/harness/smoke.sh" "scripts/harness/smoke.sh exists"
check_file "scripts/harness/test.sh" "scripts/harness/test.sh exists"
check_file "scripts/harness/lint.sh" "scripts/harness/lint.sh exists"
check_file "scripts/harness/typecheck.sh" "scripts/harness/typecheck.sh exists"
check_file ".github/workflows/harness.yml" ".github/workflows/harness.yml exists"

check_dir "docs/design-docs" "docs/design-docs/ exists"
check_dir "docs/exec-plans/active" "docs/exec-plans/active/ exists"
check_dir "docs/exec-plans/completed" "docs/exec-plans/completed/ exists"
check_dir "docs/product-specs" "docs/product-specs/ exists"
check_dir "docs/references" "docs/references/ exists"
check_dir "docs/generated" "docs/generated/ exists"

if [[ "$failures" -gt 0 ]]; then
  echo "$failures harness audit check(s) failed."
  exit 1
fi

echo "Harness audit passed."
