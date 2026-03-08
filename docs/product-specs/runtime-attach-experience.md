# Runtime Attach Experience

Status: active
Audience: contributors changing attach flows, TUI behavior, or native runtime clients
Update when: attach entrypoints, runtime focus behavior, or primary attach client changes

## Goal

Provide a reliable way to interact with active agent sessions locally while the daemon keeps remote chat surfaces in sync.

## Current Product Behavior

- `tmux` mode attaches through tmux-native session/window behavior
- `pty-rust` mode uses the runtime control plane plus stream transport for attach and interactive I/O
- the OpenTUI client is the current primary interactive surface in TypeScript

## Open Edges

- the repository contains native attach planning and runtime client work
- primary attach behavior must remain compatible with the documented runtime contracts

## Canonical References

- Runtime contract: [`../references/RUNTIME_WINDOW_API.md`](../references/RUNTIME_WINDOW_API.md)
- Native attach target contract: [`../references/RUNTIME_NATIVE_CLIENT_CONTRACT.md`](../references/RUNTIME_NATIVE_CLIENT_CONTRACT.md)
- Native attach execution plan: [`../NATIVE_ATTACH_IMPLEMENTATION_PLAN.md`](../NATIVE_ATTACH_IMPLEMENTATION_PLAN.md)
