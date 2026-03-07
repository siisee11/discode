#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${HARNESS_LINT_CMD:-}" ]]; then
  echo "+ $HARNESS_LINT_CMD"
  exec bash -lc "$HARNESS_LINT_CMD"
fi

if node -e 'const pkg=require("./package.json"); process.exit(pkg.scripts && pkg.scripts.lint ? 0 : 1)' >/dev/null 2>&1; then
  echo "+ npm run lint"
  exec npm run lint
fi

echo "No package.json lint script found; using repository static analysis fallback."

commands=(
  "npm run typecheck"
  "cargo fmt --manifest-path sidecar/pty-rust/Cargo.toml --all -- --check"
  "cargo fmt --manifest-path daemon-rs/Cargo.toml --all -- --check"
  "cargo fmt --manifest-path runtime-client-rs/Cargo.toml --all -- --check"
)

for cmd in "${commands[@]}"; do
  echo "+ $cmd"
  bash -lc "$cmd"
done
