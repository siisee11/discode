# Daemon Restart Rules

Canonical for: deciding when repository changes require a manual daemon restart
Audience: contributors changing daemon-owned code paths
Update when: daemon entrypoints or import boundaries change

Restart the daemon after changing:

- `src/index.ts`
- `src/daemon-entry.ts`
- anything under `src/capture/**`
- anything under `src/discord/**`
- anything under `src/tmux/**`
- anything under `src/state/**`
- anything under `src/config/**`
- anything under `src/agents/**`
- any other `src/**` file imported on the daemon execution path

You usually do not need a daemon restart for:

- `site/**`
- `README.md` or other documentation-only changes
- `tests/**`
- `scripts/**` only

Important note:

- `discode-src onboard` reuses an already running global daemon, so code edits are not picked up automatically

Manual restart sequence:

```bash
discode-src daemon stop
discode-src daemon start
discode-src daemon status
```
