#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${HARNESS_TEST_CMD:-}" ]]; then
  echo "+ $HARNESS_TEST_CMD"
  exec bash -lc "$HARNESS_TEST_CMD"
fi

commands=(
  "npm run test"
  "cargo test --manifest-path sidecar/pty-rust/Cargo.toml"
  "npm run daemon-rs:test"
  "npm run runtime-client:test"
)

for cmd in "${commands[@]}"; do
  echo "+ $cmd"
  bash -lc "$cmd"
done
