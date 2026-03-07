#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${HARNESS_SMOKE_CMD:-}" ]]; then
  echo "+ $HARNESS_SMOKE_CMD"
  exec bash -lc "$HARNESS_SMOKE_CMD"
fi

echo "+ npm run build"
exec npm run build
