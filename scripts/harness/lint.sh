#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${HARNESS_LINT_CMD:-}" ]]; then
  echo "+ $HARNESS_LINT_CMD"
  exec bash -lc "$HARNESS_LINT_CMD"
fi

commands=(
  "node scripts/linters/architecture-lint.mjs"
  "node scripts/linters/boundary-lint.mjs"
  "node scripts/linters/taste-lint.mjs"
  "./scripts/cleanup/scan.sh --fail-on-error"
)

if node -e 'const pkg=require("./package.json"); process.exit(pkg.scripts && pkg.scripts.lint ? 0 : 1)' >/dev/null 2>&1; then
  commands+=("npm run lint")
else
  echo "No package.json lint script found; using repository static analysis fallback."
  commands+=(
  "npm run typecheck"
  "cargo fmt --manifest-path sidecar/pty-rust/Cargo.toml --all -- --check"
  "cargo fmt --manifest-path daemon-rs/Cargo.toml --all -- --check"
  "cargo fmt --manifest-path runtime-client-rs/Cargo.toml --all -- --check"
)
fi

for cmd in "${commands[@]}"; do
  echo "+ $cmd"
  bash -lc "$cmd"
done
