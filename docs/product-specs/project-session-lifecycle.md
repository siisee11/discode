# Project Session Lifecycle

Status: active
Audience: contributors changing project creation, stop semantics, or daemon bootstrap behavior
Update when: the meaning of `new`, `attach`, `stop`, or project restoration changes

## Scope

This spec covers the user-visible lifecycle of a project-backed agent session.

## Current Lifecycle

1. `discode new` creates or resumes a project instance.
2. The daemon owns channel mappings and runtime restoration for saved instances.
3. The runtime backend provides the interactive terminal surface.
4. `attach` focuses an existing session.
5. `stop` tears down the runtime window and cleans project state, optionally preserving the chat channel depending on configuration.

## Key Constraints

- one daemon coordinates many projects
- state survives process restarts through `~/.discode/state.json`
- messaging and runtime backends should not each invent separate lifecycle rules

## Canonical References

- Architecture map: [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md)
- Runtime window contract: [`../RUNTIME_WINDOW_API.md`](../RUNTIME_WINDOW_API.md)
- Daemon restart rules: [`../operations/daemon-restart.md`](../operations/daemon-restart.md)
