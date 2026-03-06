# Reliability

This document is the canonical entrypoint for runtime reliability and operator recovery guidance.

Read next:
- [references/daemon-operations.md](/Users/dev/git/discode/docs/references/daemon-operations.md)
- [ARCHITECTURE.md](/Users/dev/git/discode/ARCHITECTURE.md)

Canonical reliability rules:

- Changes to daemon entrypoints, runtime internals, messaging bridges, state/config, or other daemon-loaded `src/**` files require a daemon restart.
- Changes limited to `site/**`, `tests/**`, `scripts/**`, `README.md`, or other docs do not require a daemon restart.
- `discode-src onboard` can reuse an already-running global daemon, so source edits are not picked up automatically unless the daemon is restarted.

Update this file when restart boundaries or runtime recovery expectations change.
