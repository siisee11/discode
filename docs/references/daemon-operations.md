# Daemon Operations

Audience:
- Maintainers and contributors working on daemon-loaded code paths

Canonical for:
- When a daemon restart is required
- Manual daemon restart procedure

## Restart Required

Restart the daemon after changes to:

- `src/index.ts`
- `src/daemon-entry.ts`
- `src/capture/**`
- `src/discord/**`
- `src/tmux/**`
- `src/state/**`
- `src/config/**`
- `src/agents/**`
- Any other `src/**` file imported on the daemon execution path

## Restart Not Required

No daemon restart is needed for changes limited to:

- `site/**`
- `README.md` and other documentation-only files
- `tests/**`
- `scripts/**` when only scripts change

## Important Note

`discode-src onboard` can reuse an already-running global daemon.
Source edits are therefore not picked up automatically unless the daemon is restarted.

## Manual Restart

```bash
discode-src daemon stop
discode-src daemon start
discode-src daemon status
```

Update this runbook when daemon-loaded paths or restart behavior changes.
