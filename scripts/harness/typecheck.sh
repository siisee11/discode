#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${HARNESS_TYPECHECK_CMD:-}" ]]; then
  echo "+ $HARNESS_TYPECHECK_CMD"
  exec bash -lc "$HARNESS_TYPECHECK_CMD"
fi

commands=(
  "npm run typecheck"
  "cargo check --manifest-path sidecar/pty-rust/Cargo.toml"
  "cargo check --manifest-path daemon-rs/Cargo.toml"
  "cargo check --manifest-path runtime-client-rs/Cargo.toml"
)

for cmd in "${commands[@]}"; do
  echo "+ $cmd"
  bash -lc "$cmd"
done
